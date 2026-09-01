// ── 工作区路径 hash（用于会话历史隔离）─────────────

// djb2 字符串 hash，输入路径先小写化（win32 下路径大小写不敏感）。
// 种子为 0，返回值固定为 8 位十六进制。改算法/种子会孤儿化已有历史数据。
export function hashWorkspacePath(p: string): string {
	const normalized = p.toLowerCase();
	let hash = 0;
	for (let i = 0; i < normalized.length; i++) {
		hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}
