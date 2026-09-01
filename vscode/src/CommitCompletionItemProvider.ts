import * as vscode from 'vscode';

export const COMMIT_TYPES = [
	{ label: 'feat', insertText: 'feat: ', description: '新功能 / New Feature' },
	{ label: 'fix', insertText: 'fix: ', description: '修复 / Bug Fix' },
	{ label: 'docs', insertText: 'docs: ', description: '文档 / Documentation' },
	{ label: 'style', insertText: 'style: ', description: '样式 / Code Style' },
	{ label: 'refactor', insertText: 'refactor: ', description: '重构 / Refactor' },
	{ label: 'perf', insertText: 'perf: ', description: '性能 / Performance' },
	{ label: 'test', insertText: 'test: ', description: '测试 / Tests' },
	{ label: 'chore', insertText: 'chore: ', description: '杂项 / Chores' },
	{ label: 'build', insertText: 'build: ', description: '构建 / Build System' },
	{ label: 'ci', insertText: 'ci: ', description: 'CI / Continuous Integration' },
	{ label: 'revert', insertText: 'revert: ', description: '回退 / Revert' },
];

// ── Dropdown completion (Ctrl+Space / trigger chars) ──────────────────────

export class CommitCompletionItemProvider implements vscode.CompletionItemProvider {
	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		context: vscode.CompletionContext
	): vscode.CompletionItem[] {
		// 同时支持 SCM 输入框和 git commit 编辑器
		const lang = document.languageId;
		if (lang !== 'scminput' && lang !== 'git-commit') {
			return [];
		}

		const linePrefix = document.lineAt(position.line).text.substring(0, position.character);

		// 如果已经包含 : 则不补全前缀
		if (linePrefix.includes(':')) {
			return [];
		}

		const partialType = linePrefix.trim().toLowerCase();
		const items: vscode.CompletionItem[] = [];

		for (const t of COMMIT_TYPES) {
			if (partialType.length === 0 || t.label.startsWith(partialType)) {
				const item = new vscode.CompletionItem(t.label, vscode.CompletionItemKind.Keyword);
				item.insertText = t.label + ': ';
				item.range = new vscode.Range(0, 0, position.line, position.character);
				item.filterText = t.label;
				item.detail = t.description;
				items.push(item);
			}
		}

		return items;
	}
}

// ── Inline ghost text (自动出现，Tab 接受) ────────────────────────────────

export class InlineCommitCompletionItemProvider implements vscode.InlineCompletionItemProvider {
	provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): vscode.InlineCompletionItem[] | null {
		const lang = document.languageId;
		if (lang !== 'scminput' && lang !== 'git-commit') {
			return [];
		}

		const linePrefix = document.lineAt(position.line).text.substring(0, position.character);

		if (linePrefix.includes(':')) {
			return [];
		}

		const partialType = linePrefix.trim().toLowerCase();

		// 空输入 → 默认提示 feat:
		if (partialType.length === 0) {
			return [new vscode.InlineCompletionItem('feat: ')];
		}

		// 匹配第一个类型
		for (const t of COMMIT_TYPES) {
			if (t.label.startsWith(partialType)) {
				const rest = t.label.substring(partialType.length) + ': ';
				return [new vscode.InlineCompletionItem(rest)];
			}
		}

		return [];
	}
}
