import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { isWithinWorkspace, isDangerousCommand } from './security';
import { truncateToolResult } from './context';
import { getMainRepository } from '../utils';

export interface ToolResult {
	content: string;
	ok: boolean;
	truncated?: boolean;
}

export interface ToolContext {
	workspaceRoot: string;
	confirm: (summary: string, detail?: string) => Promise<boolean>;
	postStatus: (msg: string) => void;
	signal: AbortSignal;
}

export interface Tool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	needsApproval?: (ctx: ToolContext, args: Record<string, unknown>) => boolean | Promise<boolean>;
	execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
	registry.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
	return registry.get(name);
}

export function listTools(): Tool[] {
	return [...registry.values()];
}

// ── read_file ──────────────────────────────────────

const readFileTool: Tool = {
	name: 'read_file',
	description: 'Read a text file. Supports line offset/limit to avoid huge outputs.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Absolute or workspace-relative file path' },
			offset: { type: 'number', description: 'Start line, 1-based (default 1)' },
			limit: { type: 'number', description: 'Max lines to return (default 500, max 1000)' },
		},
		required: ['path'],
	},
	async execute(ctx, args) {
		const p = path.resolve(ctx.workspaceRoot, String(args.path ?? ''));
		if (!isWithinWorkspace(ctx.workspaceRoot, p) && !(await ctx.confirm(`读取工作区外文件：${p}`))) {
			return { ok: false, content: 'User denied reading file outside the workspace.' };
		}
		try {
			const text = await fsp.readFile(p, 'utf-8');
			const lines = text.split('\n');
			const offset = Math.max(1, Number(args.offset) || 1);
			const limit = Math.min(1000, Number(args.limit) || 500);
			const slice = lines.slice(offset - 1, offset - 1 + limit);
			const truncated = lines.length > offset - 1 + limit;
			return {
				ok: true,
				content: slice.join('\n') + (truncated ? `\n... (${lines.length - (offset - 1 + limit)} more lines)` : ''),
				truncated,
			};
		} catch (e) {
			return { ok: false, content: `Failed to read ${p}: ${e instanceof Error ? e.message : e}` };
		}
	},
};

// ── write_file ─────────────────────────────────────

const writeFileTool: Tool = {
	name: 'write_file',
	description: 'Create or overwrite a file with the given content. Requires user confirmation.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Absolute or workspace-relative file path' },
			content: { type: 'string', description: 'Full new file content' },
		},
		required: ['path', 'content'],
	},
	needsApproval: () => true,
	async execute(ctx, args) {
		const p = path.resolve(ctx.workspaceRoot, String(args.path ?? ''));
		if (!isWithinWorkspace(ctx.workspaceRoot, p)) {
			return { ok: false, content: `Refused: ${p} is outside the workspace.` };
		}
		const content = String(args.content ?? '');
		try {
			await fsp.mkdir(path.dirname(p), { recursive: true });
			await fsp.writeFile(p, content, 'utf-8');
			return { ok: true, content: `Wrote ${content.length} chars to ${p}` };
		} catch (e) {
			return { ok: false, content: `Failed to write ${p}: ${e instanceof Error ? e.message : e}` };
		}
	},
};

// ── edit_file ──────────────────────────────────────

const editFileTool: Tool = {
	name: 'edit_file',
	description: 'Replace a unique occurrence of oldText with newText in a file. Requires user confirmation.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Absolute or workspace-relative file path' },
			oldText: { type: 'string', description: 'Exact text to replace' },
			newText: { type: 'string', description: 'Replacement text' },
		},
		required: ['path', 'oldText', 'newText'],
	},
	needsApproval: () => true,
	async execute(ctx, args) {
		const p = path.resolve(ctx.workspaceRoot, String(args.path ?? ''));
		if (!isWithinWorkspace(ctx.workspaceRoot, p)) {
			return { ok: false, content: `Refused: ${p} is outside the workspace.` };
		}
		const oldText = String(args.oldText ?? '');
		const newText = String(args.newText ?? '');
		if (!oldText) return { ok: false, content: 'oldText must not be empty.' };
		try {
			const text = await fsp.readFile(p, 'utf-8');
			const idx = text.indexOf(oldText);
			if (idx === -1) return { ok: false, content: `oldText not found in ${p}` };
			if (text.indexOf(oldText, idx + 1) !== -1) {
				return { ok: false, content: `oldText is ambiguous (multiple matches) in ${p}` };
			}
			const updated = text.slice(0, idx) + newText + text.slice(idx + oldText.length);
			await fsp.writeFile(p, updated, 'utf-8');
			return { ok: true, content: `Edited ${p} (1 replacement)` };
		} catch (e) {
			return { ok: false, content: `Failed to edit ${p}: ${e instanceof Error ? e.message : e}` };
		}
	},
};

// ── list_dir ───────────────────────────────────────

const listDirTool: Tool = {
	name: 'list_dir',
	description: 'List directory entries (type + name). Up to 200 entries.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Absolute or workspace-relative directory path' },
		},
		required: ['path'],
	},
	async execute(ctx, args) {
		const p = path.resolve(ctx.workspaceRoot, String(args.path ?? ''));
		if (!isWithinWorkspace(ctx.workspaceRoot, p) && !(await ctx.confirm(`读取工作区外目录：${p}`))) {
			return { ok: false, content: 'User denied.' };
		}
		try {
			const entries = await fsp.readdir(p, { withFileTypes: true });
			const lines = entries.slice(0, 200).map(e => `${e.isDirectory() ? 'dir ' : 'file'} ${e.name}`);
			return {
				ok: true,
				content: `Entries in ${p} (${entries.length}):\n${lines.join('\n')}` + (entries.length > 200 ? '\n... (truncated)' : ''),
				truncated: entries.length > 200,
			};
		} catch (e) {
			return { ok: false, content: `Failed to list ${p}: ${e instanceof Error ? e.message : e}` };
		}
	},
};

// ── search_files ───────────────────────────────────

// 使用稳定 API vscode.workspace.findFiles + 有界文件读取实现文本搜索
//（findTextInFiles 是 proposed API，稳定版 VS Code 会抛错）。

const searchFilesTool: Tool = {
	name: 'search_files',
	description: 'Search file contents for text within the workspace. Returns up to 50 matches with file:line:preview.',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Text to search for' },
			path: { type: 'string', description: 'Optional workspace-relative subdirectory to limit search' },
			glob: { type: 'string', description: 'Optional glob filter, e.g. **/*.ts' },
		},
		required: ['query'],
	},
	async execute(ctx, args) {
		const query = String(args.query ?? '');
		if (!query) return { ok: false, content: 'Empty search query.' };
		const sub = String(args.path ?? '').replace(/^\/+|\/+$/g, '');
		const globRaw = String(args.glob ?? '**/*');
		const include = sub ? `${sub}/${globRaw.replace(/^\//, '')}` : globRaw;
		try {
			const files = await vscode.workspace.findFiles(
				include,
				'**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/__pycache__/**',
				500
			);
			const matches: string[] = [];
			outer: for (const uri of files) {
				if (matches.length >= 50) break;
				let text: string;
				try {
					const stat = await fsp.stat(uri.fsPath);
					if (stat.size > 1024 * 1024) continue; // skip files > 1MB
					text = await fsp.readFile(uri.fsPath, 'utf-8');
				} catch { continue; }
				const lines = text.split('\n');
				for (let i = 0; i < lines.length; i++) {
					if (matches.length >= 50) break outer;
					const line = lines[i];
					if (line.includes(query)) {
						const rel = path.relative(ctx.workspaceRoot, uri.fsPath);
						matches.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
					}
				}
			}
			if (matches.length === 0) return { ok: true, content: `No matches for "${query}".` };
			const truncated = matches.length === 50;
			return { ok: true, content: `Matches for "${query}":\n${matches.join('\n')}` + (truncated ? '\n... (truncated)' : ''), truncated };
		} catch (e) {
			return { ok: false, content: `Search failed: ${e instanceof Error ? e.message : e}` };
		}
	},
};

// ── run_command ────────────────────────────────────

const runCommandTool: Tool = {
	name: 'run_command',
	description: 'Execute a shell command and capture stdout/stderr. Requires confirmation. Dangerous commands are blocked.',
	parameters: {
		type: 'object',
		properties: {
			command: { type: 'string', description: 'Shell command to run' },
			cwd: { type: 'string', description: 'Optional working directory (workspace-relative or absolute)' },
			timeoutMs: { type: 'number', description: 'Optional timeout in ms (default 30000, max 120000)' },
		},
		required: ['command'],
	},
	needsApproval: (ctx, args) => {
		const command = String(args.command ?? '').trim();
		return !isDangerousCommand(command);
	},
	async execute(ctx, args) {
		const command = String(args.command ?? '').trim();
		if (!command) return { ok: false, content: 'Empty command.' };
		if (isDangerousCommand(command)) {
			return { ok: false, content: `Blocked: dangerous command "${command}"` };
		}
		const cwd = args.cwd ? path.resolve(ctx.workspaceRoot, String(args.cwd)) : ctx.workspaceRoot;
		const timeoutMs = Math.min(120000, Number(args.timeoutMs) || 30000);
		return new Promise<ToolResult>((resolve) => {
			let stdout = '';
			let stderr = '';
			let settled = false;
			const isWin = process.platform === 'win32';
			const child = isWin
				? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, windowsHide: true })
				: spawn('/bin/sh', ['-c', command], { cwd });
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					child.kill('SIGKILL');
					resolve({ ok: false, content: `Command timed out after ${timeoutMs}ms\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}` });
				}
			}, timeoutMs);
			const onAbort = () => {
				if (!settled) {
					settled = true;
					child.kill('SIGKILL');
					resolve({ ok: false, content: 'Command aborted by user.' });
				}
			};
			if (ctx.signal.aborted) {
				onAbort();
			} else {
				ctx.signal.addEventListener('abort', onAbort, { once: true });
			}
			child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
			child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
			child.on('close', (code: number | null) => {
				clearTimeout(timer);
				ctx.signal.removeEventListener('abort', onAbort);
				if (settled) return;
				settled = true;
				resolve({
					ok: code === 0,
					content: truncateToolResult(`Exit code: ${code}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`, 4000),
					truncated: stdout.length + stderr.length > 4000,
				});
			});
			child.on('error', (err: Error) => {
				clearTimeout(timer);
				if (!settled) {
					settled = true;
					resolve({ ok: false, content: `Failed to spawn: ${err.message}` });
				}
			});
		});
	},
};

// ── git_status / git_diff / git_commit ──────────────

const gitStatusTool: Tool = {
	name: 'git_status',
	description: 'Get the current git repository status (staged / modified files).',
	parameters: { type: 'object', properties: {}, required: [] },
	async execute() {
		try {
			const repo = getMainRepository();
			const s = repo.state;
			const lines: string[] = [`HEAD: ${s.HEAD?.commit?.substring(0, 7) || '(no commits)'}`];
			const describe = (list: readonly { uri: vscode.Uri; status: number }[], label: string) => {
				if (list.length === 0) return;
				lines.push(`${label} (${list.length}):`);
				for (const c of list.slice(0, 50)) {
					const name = c.uri.fsPath.split(/[\\/]/).pop() || c.uri.fsPath;
					lines.push(`  ${name} [${c.status}]`);
				}
			};
			describe(s.indexChanges, 'Staged');
			describe(s.workingTreeChanges, 'Working tree');
			return { ok: true, content: lines.join('\n') };
		} catch (e) {
			return { ok: false, content: `Git error: ${e instanceof Error ? e.message : e}` };
		}
	},
};

const gitDiffTool: Tool = {
	name: 'git_diff',
	description: 'Get the current git diff. staged=true for staged changes, false for working tree.',
	parameters: {
		type: 'object',
		properties: {
			staged: { type: 'boolean', description: 'Staged diff if true (default), else working-tree diff' },
		},
		required: [],
	},
	async execute(ctx, args) {
		try {
			const repo = getMainRepository();
			const staged = args.staged !== false;
			const diff = await repo.diff(staged);
			if (!diff?.trim()) return { ok: true, content: '(no diff)' };
			return { ok: true, content: truncateToolResult(diff, 4000), truncated: diff.length > 4000 };
		} catch (e) {
			return { ok: false, content: `Git diff error: ${e instanceof Error ? e.message : e}` };
		}
	},
};

const gitCommitTool: Tool = {
	name: 'git_commit',
	description: 'Create a git commit from staged changes with the given message. Requires confirmation.',
	parameters: {
		type: 'object',
		properties: {
			message: { type: 'string', description: 'Commit message (subject line)' },
		},
		required: ['message'],
	},
	needsApproval: () => true,
	async execute(ctx, args) {
		const message = String(args.message ?? '').trim();
		if (!message) return { ok: false, content: 'Empty commit message.' };
		try {
			const repo = getMainRepository();
			await repo.commit(message);
			return { ok: true, content: `Committed: ${message}` };
		} catch (e) {
			return { ok: false, content: `Git commit error: ${e instanceof Error ? e.message : e}` };
		}
	},
};

// ── 注册内置工具 ───────────────────────────────────

registerTool(readFileTool);
registerTool(writeFileTool);
registerTool(editFileTool);
registerTool(listDirTool);
registerTool(searchFilesTool);
registerTool(runCommandTool);
registerTool(gitStatusTool);
registerTool(gitDiffTool);
registerTool(gitCommitTool);
