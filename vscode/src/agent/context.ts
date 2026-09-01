// ── 上下文管理：token 估算 / 工具结果裁剪 / 消息裁剪 ─────
// 这些纯函数被 tool runner 与 chat panel 用来把上下文控制在 token 预算内。
// 注意：ChatMessage 是后续任务（Task 6/7/8）共同引用的规范类型，字段形状不可随意改动。

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_call_id?: string;
    tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
}

// 粗略 token 估算：按字符数 /4 取上整（英文约 4 字符/token）。
export function estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

// 裁剪超长工具输出，保留头部并附上截断标记。
export function truncateToolResult(content: string, maxChars: number = 4000): string {
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + `\n... (truncated, ${content.length - maxChars} more chars)`;
}

// 消息裁剪：system 消息始终保留；其余消息从新到旧累计 token，超预算即截断。
// 注意：本函数面向聊天面板的展示历史，不要用于「工具调用中途」的消息数组——那类数组
// 必须保持 tool_call_id 与 tool 消息的成对顺序，随意丢弃会破坏 wire-format 不变量。
export function trimMessages(messages: ChatMessage[], maxTokens: number = 12000): ChatMessage[] {
    const system = messages.filter(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    let total = 0;
    const kept: ChatMessage[] = [];
    for (let i = rest.length - 1; i >= 0; i--) {
        const m = rest[i];
        // 始终保留最新一条非 system 消息（例如用户当前问题），即使它本身超过预算
        if (kept.length === 0) {
            kept.unshift(m);
            total += estimateTokens(m.content);
            continue;
        }
        const tokens = estimateTokens(m.content);
        if (total + tokens > maxTokens) break;
        kept.unshift(m);
        total += tokens;
    }
    return [...system, ...kept];
}
