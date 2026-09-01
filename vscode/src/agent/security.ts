import * as path from 'path';

// ── 工作区白名单判定 ─────────────────────────────

export function isWithinWorkspace(root: string, target: string): boolean {
	const absRoot = path.resolve(root);
	const absTarget = path.resolve(target);
	const rel = path.relative(absRoot, absTarget);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ── 危险命令黑名单 ──────────────────────────────

export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
	// Unix / 通用
	/\brm\s+-rf?\s+(\/|~|\*|\.)/,
	// mkfs 始终危险；format 仅在指定盘符时危险（format 单独出现多为普通词汇）
	/\b(mkfs)\b|\bformat\s+[A-Za-z]:/i,
	/\b(shutdown|reboot|poweroff)\b/i,
	/\bdd\s+if=.*of=\/dev\/(sd|hd)/i,
	/\bgit\s+push\b[^\n]*--force\b/i,
	/>:?\s*\/dev\/(sd|hd)/i,
	// Windows / PowerShell：递归或强制删除到盘符路径（/s、-Recurse/-r、-Force/-f）
	/\b(Remove-Item|rm|del|erase|rd|rmdir)\b(?=[^\n]*[A-Za-z]:[\\/])(?=[^\n]*(?:\/s\b|-\s*\b(?:Recurse|R|Force|f)\b))/i,
	// 磁盘与卷操作
	/\bClear-Disk\b/i,
	/\bFormat-Volume\b/i,
];

export function isDangerousCommand(command: string): boolean {
	return DANGEROUS_COMMAND_PATTERNS.some(p => p.test(command));
}
