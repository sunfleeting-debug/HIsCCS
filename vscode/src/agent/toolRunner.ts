import { callChatStream, ProviderConfig } from '../utils';
import { ChatMessage, truncateToolResult } from './context';
import { getTool, listTools, Tool, ToolContext, ToolResult } from './tools';

const MAX_TOOL_ROUNDS = 15;

export type ToolEvent =
    | { type: 'start'; name: string; args: Record<string, unknown> }
    | { type: 'result'; name: string; ok: boolean; content: string }
    | { type: 'approval'; name: string; summary: string };

export interface ChatRunOptions {
    messages: ChatMessage[];
    providerCfg: ProviderConfig;
    temperature: number;
    maxTokens?: number;
    tools: Tool[];
    nativeTools: boolean;
    signal: AbortSignal;
    workspaceRoot: string;
    confirm: (summary: string, detail?: string) => Promise<boolean>;
    onToken: (token: string) => void;
    onReasoning?: (token: string) => void;
    onToolEvent: (event: ToolEvent) => void;
}

function toolSchemas(tools: Tool[]): Record<string, unknown>[] {
    return tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}

function buildApprovalDetail(name: string, args: Record<string, unknown>): string {
    if (name === 'write_file') {
        const content = String(args.content ?? '');
        return `File: ${args.path}\n\n${content.slice(0, 500)}${content.length > 500 ? '\n...' : ''}`;
    }
    if (name === 'edit_file') {
        return `File: ${args.path}\n--- replace ---\n${args.oldText}\n+++ with +++\n${args.newText}`;
    }
    if (name === 'run_command') return String(args.command ?? '');
    if (name === 'git_commit') return String(args.message ?? '');
    return JSON.stringify(args, null, 2).slice(0, 500);
}

async function executeTool(
    tool: Tool | undefined,
    args: Record<string, unknown>,
    name: string,
    ctx: ToolContext,
    onToolEvent: (event: ToolEvent) => void,
): Promise<ToolResult> {
    if (!tool) {
        return { ok: false, content: `Unknown tool: ${name}` };
    }
    const needsApproval = tool.needsApproval ? await tool.needsApproval(ctx, args) : false;
    onToolEvent({ type: 'start', name, args });
    if (needsApproval) {
        const summary = `执行工具 ${name}`;
        onToolEvent({ type: 'approval', name, summary });
        const ok = await ctx.confirm(summary, buildApprovalDetail(name, args));
        if (!ok) {
            onToolEvent({ type: 'result', name, ok: false, content: `User declined to run ${name}.` });
            return { ok: false, content: `User declined to run ${name}.` };
        }
    }
    const result = await tool.execute(ctx, args);
    onToolEvent({ type: 'result', name, ok: result.ok, content: truncateToolResult(result.content, 4000) });
    return result;
}

function parseToolCalls(text: string): { name: string; args: Record<string, unknown> }[] {
    const re = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        try {
            const obj = JSON.parse(m[1]);
            if (obj && typeof obj.name === 'string') {
                calls.push({ name: obj.name, args: (obj.arguments && typeof obj.arguments === 'object') ? obj.arguments : {} });
            }
        } catch {}
    }
    return calls;
}

function buildFallbackSystem(originalSystem: string, tools: Tool[]): string {
    const toolDescs = tools.map(t =>
        `- ${t.name}: ${t.description}\n  arguments schema: ${JSON.stringify(t.parameters)}`
    ).join('\n');
    return `${originalSystem}\n\nYou may call tools when needed. To call a tool, output EXACTLY one line with a JSON block:\n<tool_call>\n{"name":"<tool_name>","arguments":{...}}\n</tool_call>\n\nThen the tool result will be provided to you. Wait for the result before continuing. You must NOT fabricate tool results.\n\nAvailable tools:\n${toolDescs}`;
}

export async function runChat(options: ChatRunOptions): Promise<string> {
    const ctx: ToolContext = {
        workspaceRoot: options.workspaceRoot,
        confirm: options.confirm,
        postStatus: () => {},
        signal: options.signal,
    };
    const tools = options.tools.length > 0 ? options.tools : listTools();

    let executedTools = false;
    const nativeLoop = async (): Promise<string> => {
        const msgs: ChatMessage[] = [...options.messages];
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (options.signal.aborted) throw new Error('Stopped by user');
            const result = await callChatStream(
                msgs,
                options.providerCfg,
                options.temperature,
                options.maxTokens,
                options.onToken,
                options.onReasoning,
                { tools: toolSchemas(tools), signal: options.signal },
            );
            if (result.toolCalls.length === 0) return result.text;
            const assistantMsg: ChatMessage = {
                role: 'assistant',
                content: result.text,
                tool_calls: result.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments },
                })),
            };
            msgs.push(assistantMsg);
            for (const call of result.toolCalls) {
                let args: Record<string, unknown>;
                try {
                    args = JSON.parse(call.arguments || '{}');
                } catch {
                    args = { _raw: call.arguments };
                }
                const tool = getTool(call.name);
                executedTools = true;
                const outcome = await executeTool(tool, args, call.name, ctx, options.onToolEvent);
                msgs.push({ role: 'tool', tool_call_id: call.id, content: truncateToolResult(outcome.content) });
            }
        }
        throw new Error('Tool call limit reached (15 rounds)');
    };

    const fallbackLoop = async (): Promise<string> => {
        let msgs: ChatMessage[] = [...options.messages];
        msgs = msgs.map((m, i) => i === 0 && m.role === 'system'
            ? { ...m, content: buildFallbackSystem(m.content, tools) }
            : m);
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (options.signal.aborted) throw new Error('Stopped by user');
            const result = await callChatStream(
                msgs,
                options.providerCfg,
                options.temperature,
                options.maxTokens,
                options.onToken,
                options.onReasoning,
                { signal: options.signal },
            );
            const calls = parseToolCalls(result.text);
            if (calls.length === 0) return result.text;
            let acc = result.text;
            for (const call of calls) {
                const tool = getTool(call.name);
                const outcome = await executeTool(tool, call.args, call.name, ctx, options.onToolEvent);
                acc += `\n<tool_result name="${call.name}">\n${truncateToolResult(outcome.content)}\n</tool_result>`;
            }
            msgs = [
                ...msgs,
                { role: 'assistant', content: result.text },
                { role: 'user', content: `Tool results:\n${acc}` },
            ];
        }
        throw new Error('Tool call limit reached (15 rounds)');
    };

    if (!options.nativeTools) return fallbackLoop();
    try {
        return await nativeLoop();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 仅在没有任何工具真正执行前（round 1 的 API 调用失败）才降级到回退循环；
        // 若已执行过工具（例如 git_commit 已提交），整体重启会重复副作用，直接上抛。
        if (!executedTools && /tools|function calling|tool[_ -]?calls|not supported|unsupported/i.test(msg)) {
            return fallbackLoop();
        }
        throw e;
    }
}
