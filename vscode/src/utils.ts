/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { GitExtension, Commit, Status } from './api/git';
import fetch from 'node-fetch';
import { t } from './i18n';
import { ChatMessage } from './agent/context';

// 用于向 webview 发送状态更新的回调
let _statusCallback: ((msg: string) => void) | null = null;

export function setStatusCallback(cb: ((msg: string) => void) | null) {
	_statusCallback = cb;
}

function postStatus(msg: string) {
	try {
		_statusCallback?.(msg);
	} catch { /* webview 可能已销毁 */ }
}

// ── 各 AI 提供商的 API 地址 ──────────────────────────
export const PROVIDER_BASE_URLS: Record<string, string> = {
	deepseek: 'https://api.deepseek.com',
	qwen: 'https://dashscope.aliyuncs.com/compatible-mode',
	openai: 'https://api.openai.com',
};

const PROVIDER_MODELS: Record<string, string> = {
	deepseek: 'deepseek-chat',
	qwen: 'qwen-plus',
	openai: 'gpt-4o-mini',
};

export interface ProviderConfig {
	baseUrl: string;
	model: string;
	apiKey: string;
}

// ── 内存缓存（保存后立即生效，无需等 VS Code 配置写入）──
export interface MemoryCache {
	apiKey?: string;
	provider?: string;
	baseUrl?: string;
	modelName?: string;
	apiEndpoint?: string;
	withHistory?: boolean;
	temperature?: number;
	maxTokens?: number;
	suggestionCount?: number;
	prefixMode?: string;
	standardPrefix?: string;
	customPrefix?: string;
	language?: string;
	uiLanguage?: string;
}

let _memoryCache: MemoryCache = {};

export function setMemoryConfig(cfg: MemoryCache) {
	_memoryCache = { ...cfg };
}

function readConfig(overrideConfig?: MemoryCache) {
	if (overrideConfig) {
		return {
			apiKey: overrideConfig.apiKey || '',
			provider: overrideConfig.provider || 'deepseek',
			baseUrl: overrideConfig.baseUrl || '',
			modelName: overrideConfig.modelName || '',
			apiEndpoint: overrideConfig.apiEndpoint || '',
			withHistory: overrideConfig.withHistory ?? false,
			temperature: overrideConfig.temperature ?? 0.7,
			maxTokens: overrideConfig.maxTokens ?? 200,
			suggestionCount: overrideConfig.suggestionCount ?? 5,
			prefixMode: overrideConfig.prefixMode || 'standard',
			standardPrefix: overrideConfig.standardPrefix || '',
			customPrefix: overrideConfig.customPrefix || '',
			language: overrideConfig.language || 'auto',
			uiLanguage: overrideConfig.uiLanguage || 'auto',
		};
	}
	const config = vscode.workspace.getConfiguration('cmg');
	return {
		apiKey: _memoryCache.apiKey || config.apiKey || '',
		provider: _memoryCache.provider || config.provider || 'deepseek',
		baseUrl: _memoryCache.baseUrl || config.baseUrl || '',
		modelName: _memoryCache.modelName || config.modelName || '',
		apiEndpoint: _memoryCache.apiEndpoint || config.apiEndpoint || '',
		withHistory: _memoryCache.withHistory ?? config.AccordingHistoryOrNot ?? false,
		temperature: _memoryCache.temperature ?? config.temperature ?? 0.7,
		maxTokens: _memoryCache.maxTokens ?? config.max_tokens ?? 200,
		suggestionCount: _memoryCache.suggestionCount ?? config.suggestionCount ?? 5,
		prefixMode: _memoryCache.prefixMode || config.prefixMode || 'standard',
		standardPrefix: _memoryCache.standardPrefix || config.standardPrefix || '',
		customPrefix: _memoryCache.customPrefix || config.customPrefix || '',
		language: _memoryCache.language || config.language || 'auto',
		uiLanguage: _memoryCache.uiLanguage || config.uiLanguage || 'auto',
	};
}

function getProviderConfig(overrideConfig?: MemoryCache): ProviderConfig | null {
	const { apiKey, provider, baseUrl, modelName } = readConfig(overrideConfig);
	if (!apiKey) {
		return null;
	}

	const defaultBaseUrl = PROVIDER_BASE_URLS[provider] || PROVIDER_BASE_URLS.deepseek;
	const baseUrlFinal = baseUrl || defaultBaseUrl;
	const model = modelName || PROVIDER_MODELS[provider] || PROVIDER_MODELS.deepseek;

	return { baseUrl: baseUrlFinal, model, apiKey };
}

// ── 获取模型列表 ─────────────────────────────────────

export async function fetchModels(apiKey: string, baseUrl: string): Promise<{ id: string }[]> {
	const url = baseUrl.replace(/\/+$/, '');
	const finalUrl = url.endsWith('/v1') ? `${url}/models` : `${url}/v1/models`;
	const response = await fetch(finalUrl, {
		headers: { 'Authorization': `Bearer ${apiKey}` },
	});
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`Fetch models failed (${response.status}): ${text || response.statusText}`);
	}
	const result: any = await response.json();
	if (!result?.data || !Array.isArray(result.data)) {
		throw new Error('API response format error: missing data array');
	}
	return result.data.map((m: any) => ({ id: m.id }));
}

// ── 测速 ────────────────────────────────────────────

export async function testApiSpeed(apiKey: string, baseUrl: string): Promise<{ status: number; ms: number }> {
	const url = baseUrl.replace(/\/+$/, '');
	const finalUrl = url.endsWith('/v1') ? `${url}/models` : `${url}/v1/models`;
	const start = Date.now();
	const response = await fetch(finalUrl, {
		headers: { 'Authorization': `Bearer ${apiKey}` },
	});
	const ms = Date.now() - start;
	return { status: response.status, ms };
}

// ── 获取 Git 仓库 ─────────────────────────────────────

export const getMainRepository = () => {
	const gitExtensions = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!gitExtensions || !gitExtensions.exports) {
		throw new Error('Git extension not found! Git extension must be enabled for this plugin to work');
	}

	const gitApi = gitExtensions.exports.getAPI(1);
	if (!gitApi.repositories || gitApi.repositories.length === 0) {
		throw new Error('No git repositories found. Please open a git repository in VS Code.');
	}

	return gitApi.repositories[0];
};

export const getCommitHistory = async (maxCount: number): Promise<Commit[]> => {
	const repository = getMainRepository();
	return await repository.log({ maxEntries: maxCount });
};

// ── BM25 full-text search for commit messages ─────────

/** Simple tokenizer: lowercase, split on non-alphanum, filter short words */
function tokenize(text: string): string[] {
	return text.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(t => t.length > 1);
}

interface BM25Index {
	avgdl: number;
	N: number;
	docLengths: number[];
	termFreqs: Map<string, number[]>[];
}

const K1 = 1.2;
const B = 0.75;

function buildIndex(docs: string[]): BM25Index {
	const N = docs.length;
	const docLengths: number[] = [];
	const termFreqs: Map<string, number[]>[] = [];
	let totalLen = 0;

	for (const doc of docs) {
		const tokens = tokenize(doc);
		docLengths.push(tokens.length);
		totalLen += tokens.length;
		const tf = new Map<string, number[]>();
		for (const t of tokens) {
			const entry = tf.get(t) || [0];
			entry[0]++;
			tf.set(t, entry);
		}
		termFreqs.push(tf);
	}

	const avgdl = totalLen / N;
	return { avgdl, N, docLengths, termFreqs };
}

function idf(N: number, df: number): number {
	return Math.log((N - df + 0.5) / (df + 0.5) + 1);
}

function scoreDoc(
	queryTerms: string[],
	idx: number,
	index: BM25Index,
): number {
	const { avgdl, docLengths, termFreqs } = index;
	const dl = docLengths[idx];
	const tfMap = termFreqs[idx];
	let score = 0;

	for (const term of queryTerms) {
		const tf = (tfMap.get(term)?.[0]) || 0;
		if (tf === 0) continue;
		// document frequency = how many docs contain this term
		let df = 0;
		for (let j = 0; j < index.N; j++) {
			if (index.termFreqs[j].has(term)) df++;
		}
		const idfVal = idf(index.N, df);
		score += idfVal * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dl / avgdl));
	}
	return score;
}

export interface CommitSearchResult {
	commit: Commit;
	score: number;
}

/** Search commits by BM25 relevance. Returns results sorted by score descending. */
export function searchCommitsBM25(commits: Commit[], query: string): CommitSearchResult[] {
	if (!query.trim()) return commits.map(c => ({ commit: c, score: 0 }));

	const queryTerms = tokenize(query).filter(t => t.length > 1);
	if (queryTerms.length === 0) return commits.map(c => ({ commit: c, score: 0 }));

	const docs = commits.map(c => `${c.message} ${c.authorName || ''}`);
	const index = buildIndex(docs);

	const results: CommitSearchResult[] = [];
	for (let i = 0; i < commits.length; i++) {
		const score = scoreDoc(queryTerms, i, index);
		if (score > 0) results.push({ commit: commits[i], score });
	}

	// fallback: if BM25 finds nothing, return first 10 by prefix match
	if (results.length === 0) {
		const q = query.toLowerCase();
		for (const c of commits) {
			const msg = (c.message + ' ' + (c.authorName || '')).toLowerCase();
			if (msg.includes(q)) results.push({ commit: c, score: 0.1 });
		}
	}

	return results.sort((a, b) => b.score - a.score);
}

// ── Get changed files for a specific commit ──────────

function statusLabel(s: Status): string {
	const map: Record<number, string> = {
		[Status.INDEX_MODIFIED]: 'modified',  [Status.INDEX_ADDED]: 'added',
		[Status.INDEX_DELETED]: 'deleted',    [Status.INDEX_RENAMED]: 'renamed',
		[Status.MODIFIED]: 'modified',        [Status.DELETED]: 'deleted',
		[Status.ADDED_BY_US]: 'added',        [Status.ADDED_BY_THEM]: 'added',
		[Status.DELETED_BY_US]: 'deleted',    [Status.DELETED_BY_THEM]: 'deleted',
		[Status.BOTH_ADDED]: 'added',         [Status.BOTH_DELETED]: 'deleted',
		[Status.BOTH_MODIFIED]: 'modified',
	};
	return map[s] ?? 'unknown';
}

export const getCommitChanges = async (hash: string): Promise<{ file: string; status: string }[]> => {
	const repository = getMainRepository();
	const commit = await repository.getCommit(hash);
	if (commit.parents.length === 0) return [];
	const root = repository.rootUri.fsPath;
	const changes = await repository.diffBetween(commit.parents[0], hash);
	return changes.map(c => ({
		file: c.uri.fsPath.replace(root + path.sep, '').replace(/\\/g, '/'),
		status: statusLabel(c.status),
	}));
};

// ── 构建 AI Prompt ──────────────────────────────────

function buildPrompt(diff: string, history?: string[], count: number = 1, similarCommits?: string[], prefixMode?: string, standardPrefix?: string, customPrefix?: string, language?: string, userInput?: string): { system: string; user: string } {
	// 补全模式：以用户输入为起点，在输入后面续写
	if (userInput) {
		return buildCompletionPrompt(diff, userInput, history, language, count);
	}
	const isZh = resolveTargetLanguage(language) === 'zh';

	if (isZh) {
		return buildPromptZh(diff, history, count, similarCommits, prefixMode, standardPrefix, customPrefix);
	}
	return buildPromptEn(diff, history, count, similarCommits, prefixMode, standardPrefix, customPrefix, language);
}

// 补全模式提示词：严格按照用户输入，在输入后面补全
function buildCompletionPrompt(diff: string, userInput: string, history: string[] | undefined, language?: string, count: number = 1, similarCommits?: string[]): { system: string; user: string } {
	const targetLang = resolveTargetLanguage(language);
	const diffSection = diff?.trim() ? `\n\n## 代码变更（参考）\n"""\n${diff}\n"""` : '';
	const historySection = history && history.length > 0 ? `\n\n## 该仓库近期提交风格（参考）\n${history.map(h => `- ${h}`).join('\n')}` : '';

	const angleNamesZh = ['简洁一句话，直击核心', '标题+详细描述，说明改动原因和影响范围', '侧重实现细节，提及具体函数/模块', '侧重用户/产品价值', '先说痛点/问题，再说如何解决', '侧重性能影响和优化效果', '侧重安全性改进', '侧重架构/设计变更', '侧重测试覆盖和回归风险', '侧重开发者体验和工具链'];
	const angleNamesEn = ['One sentence, concise and direct', 'Title + detailed description, explaining reason and impact', 'Focus on implementation details, mention specific functions/modules', 'Focus on user/product value, less technical details', 'Start with the pain point/problem, then explain the solution', 'Focus on performance impact and optimization', 'Focus on security improvements', 'Focus on architecture/design changes', 'Focus on test coverage and regression risk', 'Focus on developer experience and tooling'];

	const styleGuideZh = count > 1 ? `

本次需要一次性生成 ${count} 条不同的 commit message 续写，每条必须采用**不同的写法角度**：

${Array.from({ length: count }, (_, k) => `角度 ${k + 1} — ${angleNamesZh[k] || `${count} 种不同角度之一`}`).join('\n')}

⚠️ 重要：每条只输出 commit message 的续写部分（用户输入之后的内容），不要标注"角度1"等任何标签前缀！每条单独占一行，按顺序输出。` : '';

	const styleGuideEn = count > 1 ? `

You need to generate ${count} different commit message continuations, each using a **different writing angle**:

${Array.from({ length: count }, (_, k) => `Angle ${k + 1} — ${angleNamesEn[k] || `${count} different angles`}`).join('\n')}

⚠️ Important: Output only the continuation for each (text that follows the user's input), do NOT label which angle you used. Each continuation on a separate line, in order.` : '';

	if (targetLang === 'zh') {
		const system = `你是一个专业的 Git Commit Message 补全助手。
用户正在编写 commit message，已经输入了开头部分。请以用户的输入为唯一起点，在它【后面】继续补全，拼成一条完整、通顺的 commit message。${diffSection}${historySection}

【关键规则】
1. 只输出用户已输入内容【之后】的补全部分，绝对禁止重复、改写或重述用户已输入的任何内容
2. 补全内容必须与用户输入自然衔接，两者合并后是一条完整的 commit message
3. 不要输出 "角度1:"、"编号"、引号或任何标签/解释性前缀
4. 直接输出补全文本本身，不要任何多余的解释${styleGuideZh}`;
		const user = `用户已输入的内容（只读，不要重复）：\n"""\n${userInput}\n"""\n\n请严格在它【后面】继续补全${count > 1 ? `（一次性生成 ${count} 条，每条单独一行）` : ''}。`;
		return { system, user };
	}

	const system = `You are a Git Commit Message completion assistant.
The user has already typed the beginning of a commit message. Use the user's input as the single starting point and continue writing AFTER it to form one complete, natural commit message.${diff?.trim() ? `\n\n## Code changes (reference)\n"""\n${diff}\n"""` : ''}${history && history.length > 0 ? `\n\n## Recent commit style in this repo (reference)\n${history.map(h => `- ${h}`).join('\n')}` : ''}

【Rules】
1. Output ONLY the continuation that follows the user's typed input. NEVER repeat, rewrite, or restate any part of the user's input.
2. The continuation must connect naturally with the user's input so the two read as one complete commit message.
3. Do not include labels such as "Angle 1:", numbering, quotes, or any explanatory prefix.
4. Output the continuation text only, with no extra explanation.${styleGuideEn}`;
	const user = `User's typed input (read-only, do NOT repeat):\n"""\n${userInput}\n"""\n\nStrictly continue writing right AFTER this input${count > 1 ? ` (generate ${count} different continuations, each on its own line)` : ''}.`;
	return { system, user };
}

function buildPromptZh(diff: string, history?: string[], count: number = 1, similarCommits?: string[], prefixMode?: string, standardPrefix?: string, customPrefix?: string): { system: string; user: string } {
	// 动态生成「N 个不同角度」的描述
	const angleNames = ['简洁一句话，直击核心', '标题+详细描述，说明改动原因和影响范围', '侧重实现细节，提及具体函数/模块', '侧重用户/产品价值', '先说痛点/问题，再说如何解决', '侧重性能影响和优化效果', '侧重安全性改进', '侧重架构/设计变更', '侧重测试覆盖和回归风险', '侧重开发者体验和工具链'];
	const angleDescs: string[] = [];
	for (let k = 0; k < count; k++) {
		angleDescs.push(`角度 ${k + 1} — ${angleNames[k] || `${count} 种不同角度之一`}`);
	}
	const styleGuide = count > 1 ? `

本次需要一次性生成 ${count} 条不同的 commit message，每条必须采用**不同的写法角度**：

${angleDescs.join('\n')}

⚠️ 重要：每条只输出 commit message 本身，不要标注"角度1"等任何标签前缀！
每条 message 的类型标签也要相应变化，不要全用同一种类型。` : '';

	let prefixInstruction = '';
	let showStandardTypes = true;

	if (prefixMode === 'custom' && customPrefix) {
		showStandardTypes = false;
		prefixInstruction = `本次 commit message 必须使用自定义前缀 "${customPrefix}:"。请理解该前缀的含义并在后续描述中体现其语义方向。
格式：${customPrefix}: <标题>

例如，若自定义前缀为 "新功能"，则 AI 应理解为本次提交新增了功能特性，围绕此方向撰写描述。`;
	} else if (prefixMode === 'standard' && standardPrefix) {
		showStandardTypes = false;
		prefixInstruction = `本次所有 commit message 必须使用固定的类型前缀 "${standardPrefix}:"。不要使用其他类型前缀。每条都必须以 ${standardPrefix}: 开头。`;
	} else {
		prefixInstruction = `请根据代码变更内容自动选择合适的类型前缀。`;
	}

	const system = `你是一个专业的 Git Commit Message 生成助手。
根据提供的代码变更（git diff），生成符合以下规则的提交信息。${showStandardTypes ? `
可用的类型前缀：
- feat:      新功能
- fix:       Bug 修复
- docs:      文档更新
- style:     代码格式（不影响功能）
- refactor:  代码重构
- perf:      性能优化
- test:      测试相关
- chore:     构建/工具链变更
- revert:    回退操作` : ''}
【关键规则】
1. **输出语言必须是纯中文**，标题和描述全部用中文写，严禁出现任何英文/日文等其他语言的单词和句子
2. 第一行是标题（50字以内），空一行后跟详细描述（可选）
3. 具体说明做了什么、为什么做
4. 不要出现模糊词汇
5. 只返回 commit message，不要多余的解释

${prefixInstruction}${styleGuide}`;

	let user = `请根据以下代码变更生成 Git commit message：\n\n\`\`\`diff\n${diff}\n\`\`\``;
	if (history && history.length > 0) {
		user += `\n\n参考该仓库近期的提交风格：\n${history.map(h => `- ${h}`).join('\n')}`;
	}
	return { system, user };
}

function buildPromptEn(diff: string, history?: string[], count: number = 1, similarCommits?: string[], prefixMode?: string, standardPrefix?: string, customPrefix?: string, language?: string): { system: string; user: string } {
	const targetLang = resolveTargetLanguage(language);
	const langName = (() => {
		switch (targetLang) {
			case 'ja': return 'Japanese';
			case 'ru': return 'Russian';
			case 'fr': return 'French';
			case 'de': return 'German';
			default: return 'English';
		}
	})();

	// 动态生成「N 个不同角度」的描述
	const angleNames = ['One sentence, straight to the point, concise and powerful', 'Title + detailed description, explaining reason and impact', 'Focus on implementation details, mention specific functions/modules/terms', 'Focus on user/product value, less technical details', 'Start with the pain point/problem, then explain the solution', 'Focus on performance impact and optimization', 'Focus on security improvements', 'Focus on architecture/design changes', 'Focus on test coverage and regression risk', 'Focus on developer experience and tooling'];
	const angleDescs: string[] = [];
	for (let k = 0; k < count; k++) {
		angleDescs.push(`Angle ${k + 1} — ${angleNames[k] || `${count} different angles`}`);
	}
	const styleGuide = count > 1 ? `

You need to generate ${count} different commit messages at once, each using a **different writing angle**:

${angleDescs.join('\n')}

⚠️ Important: Output only the commit message itself, do NOT label which angle you used.
Each message should also use a different type prefix.` : '';

	let prefixInstruction = '';
	let showStandardTypes = true;

	if (prefixMode === 'custom' && customPrefix) {
		showStandardTypes = false;
		prefixInstruction = `All commit messages MUST use the custom prefix "${customPrefix}:". Understand the meaning of this prefix and reflect it in the description.
Format: ${customPrefix}: <title>`;
	} else if (prefixMode === 'standard' && standardPrefix) {
		showStandardTypes = false;
		prefixInstruction = `All commit messages MUST use the fixed type prefix "${standardPrefix}:". Do not use other type prefixes. Every message must start with ${standardPrefix}:.`;
	} else {
		prefixInstruction = `Choose the appropriate type prefix based on the code changes.`;
	}

	const system = `You are a professional Git Commit Message generator.
Generate commit messages based on the git diff below.${showStandardTypes ? `
Available type prefixes:
- feat:     New feature
- fix:      Bug fix
- docs:     Documentation
- style:    Code style (no functional change)
- refactor: Code refactoring
- perf:     Performance improvement
- test:     Testing
- chore:    Build/tooling
- revert:   Revert` : ''}
## LANGUAGE RULE
You MUST ONLY output ${langName}. NEVER output Chinese. This is a hard requirement.

## FORMAT
First line is the title (under 50 chars), optionally followed by a blank line and detailed description.
Be specific about what and why. Avoid vague words.
Output only the commit message, no extra explanation.

${prefixInstruction}${styleGuide}`;

	let userPrompt = 'Please generate a Git commit message for the following code diff:';
	if (targetLang === 'ja') userPrompt = '以下のコード差分に対する Git commit message を生成してください：';
	else if (targetLang === 'ru') userPrompt = 'Пожалуйста, создайте Git commit message для следующего diff:';
	else if (targetLang === 'fr') userPrompt = 'Veuillez générer un message de commit Git pour le diff suivant :';
	else if (targetLang === 'de') userPrompt = 'Bitte generieren Sie eine Git-Commit-Nachricht für den folgenden Diff:';

	let user = `${userPrompt}\n\n\`\`\`diff\n${diff}\n\`\`\``;
	if (history && history.length > 0) {
		let historyLabel = 'Reference recent commit style from this repo:';
		if (targetLang === 'ja') historyLabel = 'このリポジトリの最近のコミットスタイルを参考：';
		else if (targetLang === 'ru') historyLabel = 'Стиль недавних коммитов этого репозитория:';
		else if (targetLang === 'fr') historyLabel = 'Référence des commits récents de ce dépôt :';
		else if (targetLang === 'de') historyLabel = 'Referenz der letzten Commits in diesem Repository:';
		user += `\n\n${historyLabel}\n${history.map(h => `- ${h}`).join('\n')}`;
	}
	return { system, user };
}

// ── 检测是否包含中文字符 ───────────────────────────
function containsChinese(text: string): boolean {
	return /[一-鿿㐀-䶿豈-﫿]/.test(text);
}

/** Build retrieval-augmented section for similar historical commit examples */
function buildAugmentedSection(similarCommits: string[], targetLang: string): string {
	if (!similarCommits || similarCommits.length === 0) return '';
	const list = similarCommits.slice(0, 3).map(m => `- ${m}`).join('\n');
	if (targetLang === 'zh') {
		return `\n\n## 相似历史提交示例（用于参考表达风格）\n${list}`;
	}
	return `\n\n## Similar historical commit examples (for style reference)\n${list}`;
}





// ── 解析目标语言 ──────────────────────────────────
function resolveTargetLanguage(language?: string): string {
	if (language === 'zh') return 'zh';
	if (language && language !== 'auto') return language;
	try {
		const uiLang = vscode.env.language;
		if (uiLang.startsWith('zh')) return 'zh';
		if (uiLang.startsWith('ja')) return 'ja';
		if (uiLang.startsWith('fr')) return 'fr';
		if (uiLang.startsWith('de')) return 'de';
		if (uiLang.startsWith('ru')) return 'ru';
	} catch {}
	return 'en';
}

// ── 直连 AI API（OpenAI 兼容格式）───────────────────

async function callAI(
	diff: string,
	history: string[] | undefined,
	providerCfg: ProviderConfig,
	predictionCount: number,
	temperature: number,
	maxTokens: number,
	prefixMode?: string,
	standardPrefix?: string,
	customPrefix?: string,
	language?: string,
	userInput?: string,
	similarCommits?: string[],
): Promise<string[]> {
	const n = Math.max(1, Math.min(predictionCount, 10));
	const targetLang = resolveTargetLanguage(language);
	const langNames: Record<string, string> = {
		en: 'English', ja: 'Japanese', ru: 'Russian',
		fr: 'French', de: 'German',
	};

	const doFetch = async (extraInstruction?: string): Promise<string[]> => {
		const { system, user } = buildPrompt(diff, history, n, similarCommits, prefixMode, standardPrefix, customPrefix, language, userInput);

		const messages = [
			{ role: 'system', content: extraInstruction ? `${system}\n\n${extraInstruction}` : system },
			{ role: 'user', content: user },
		];

		const body = {
			model: providerCfg.model,
			messages,
			temperature: Math.max(0, Math.min(2, temperature)),
			max_tokens: maxTokens * Math.max(1, n),
			n: 1,  // 所有 API 都支持 n=1，通过 prompt 让 AI 一次性生成多条
		};

		const apiUrl = providerCfg.baseUrl.replace(/\/+$/, '');

		const response = await fetch(apiUrl.endsWith("/v1") ? `${apiUrl}/chat/completions` : `${apiUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${providerCfg.apiKey}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => '');
			throw new Error(`AI API error ${response.status}: ${errText || response.statusText}`);
		}

		const result: any = await response.json();

		if (!result?.choices || !Array.isArray(result.choices)) {
			throw new Error(`Invalid AI API response: missing choices`);
		}

		// 从 AI 返回的文本中拆分多条 commit message
		const fullText = (result.choices[0]?.message?.content || '').trim();
		if (!fullText) return [];

		// 先按行拆分并去重
		const linesList = fullText.split('\n').map((l: string) => l.trim()).filter(Boolean);
		// 去掉 AI 多候选输出中的编号标签，如 "angle3:" / "角度1:" / "suggestion 2:"
		const stripLabel = (l: string) => l.replace(/^(angle|角度|suggestion|候选|编号)\s*\d*\s*[:：]\s*/i, '').trim();
		const prefixRe = /^(feat|fix|docs|style|refactor|perf|test|chore|revert|BREAKING CHANGE)\b/i;
		const seen = new Set<string>();
		const messages_result: string[] = [];
		// 补全模式下 AI 只返回续写部分，不要求以类型前缀开头
		if (!userInput) {
			for (const line of linesList) {
				const stripped = stripLabel(line);
				const clean = stripped.replace(/^[-*\d]+[.、\)]\s*/, '').trim();
				if (!clean || seen.has(clean)) continue;
				if (prefixRe.test(stripped) || prefixRe.test(clean)) {
					seen.add(clean);
					messages_result.push(clean);
				}
			}
		}
		// 数量不够时放宽条件
		if (messages_result.length < n) {
			for (const line of linesList) {
				if (messages_result.length >= n) break;
				const stripped = stripLabel(line);
				const clean = stripped.replace(/^[-*\d]+[.、\)]\s*/, '').trim();
				if (!clean || seen.has(clean)) continue;
				if (/^(here|sure|ok|好的|这是|以下|根据|基于|注意|总结|commit message)/i.test(clean)) continue;
				if (clean.length < 5) continue;
				seen.add(clean);
				messages_result.push(clean);
			}
		}

		return messages_result.slice(0, n);
	};

	// 一次请求
	const results = await doFetch();

	// 非中文模式下检测中文并重试（最多 3 次）
	const MAX_RETRIES = 3;
	if (targetLang !== 'zh' && results.length > 0) {
		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			const badIndices: number[] = [];
			results.forEach((msg, i) => {
				const desc = msg.replace(/^[a-zA-Z]+:\s*/, '');
				if (containsChinese(desc)) {
					badIndices.push(i);
				}
			});

			if (badIndices.length === 0) break;

			console.warn(`[BlueCome] Retry ${attempt}/${MAX_RETRIES}: ${badIndices.length}/${results.length} still have Chinese`);

			const retryInstruction = [
				`STRICT LANGUAGE REQUIREMENT: Your previous response still contained Chinese characters.`,
				`This is ABSOLUTELY NOT ALLOWED.`,
				`You MUST write EVERY message ENTIRELY in ${langNames[targetLang] || 'English'}.`,
				`Do not use a single Chinese character.`,
			].join('\n');

			const retryResults = await doFetch(retryInstruction);

			let retryIdx = 0;
			for (const idx of badIndices) {
				if (retryIdx < retryResults.length) {
					const candidate = retryResults[retryIdx];
					if (!containsChinese(candidate.replace(/^[a-zA-Z]+:\s*/, ''))) {
						results[idx] = candidate;
					}
				}
				retryIdx++;
			}
		}
	}

	return results;
}

// ── 代理模式：通过用户的后端服务 ─────────────────────

async function callBackend(
	diff: string,
	history: string[] | undefined,
	endpoint: string,
	predictionCount: number,
	temperature: number,
	maxTokens: number,
	userInput?: string,
	language?: string,
	similarCommits?: string[],
): Promise<string[]> {
	const payload: Record<string, any> = {
		diff,
		needRec: predictionCount > 1 ? 1 : 0,
		temperature,
		max_tokens: predictionCount > 1 ? maxTokens * predictionCount : maxTokens,
		// auto 时前端解析为显式语言（跟随 VS Code 系统语言），后端无需自行猜测
		language: language && language !== 'auto' ? language : resolveTargetLanguage(language),
	};

	if (userInput) {
		payload.userInput = userInput;
	}
	if (history && history.length > 0) {
		payload.historyMessage = history;
	}
	if (similarCommits && similarCommits.length > 0) {
		payload.similarCommits = similarCommits;
	}

	const response = await fetch(`${endpoint}/cmg`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		throw new Error(`Backend error ${response.status}: ${response.statusText}`);
	}

	const result: any = await response.json();

	if (!result?.commit_message || !Array.isArray(result.commit_message)) {
		throw new Error('Invalid backend response: expected commit_message array');
	}

	return result.commit_message;
}

// ── 对外接口 ──────────────────────────────────────────

export const fetchCommitMessage = async (predictionCount: number, overrideConfig?: MemoryCache, userInput?: string): Promise<string[]> => {
	const repository = getMainRepository();

	// 获取暂存区的 diff，没有则工作区 diff
	let changes = await repository.diff(true);
	if (!changes?.trim()) {
		changes = await repository.diff(false);
	}
	if (!changes?.trim() && !userInput) {
		vscode.window.showErrorMessage(t('errNoChanges'));
		return [];
	}

	const cfg = readConfig(overrideConfig);
	const endpoint: string = cfg.apiEndpoint;
	const apiKey: string = cfg.apiKey;
	const withHistory: boolean = cfg.withHistory;
	const temperature: number = cfg.temperature;
	const maxTokens: number = cfg.maxTokens;
	const prefixMode: string = cfg.prefixMode || 'standard';
	const standardPrefix: string = cfg.standardPrefix || '';
	const customPrefix: string = cfg.customPrefix || '';
	const language: string = cfg.language || 'auto';

	// Retrieval-augmented: find semantically similar commits via BM25
	const allCommits = await getCommitHistory(50);
	const similarCommits = searchCommitsBM25(allCommits, changes).slice(0, 5).map(r => r.commit.message);

	// 获取历史消息
	let history: string[] | undefined;
	if (withHistory) {
		const commits = await getCommitHistory(10);
		history = commits.map(c => c.message);
	}

	try {
		if (endpoint) {
			return await callBackend(changes, history, endpoint.trim(), predictionCount, temperature, maxTokens, userInput, language, similarCommits);
		} else if (apiKey) {
			const providerCfg = getProviderConfig(overrideConfig)!;
			return await callAI(changes, history, providerCfg, predictionCount, temperature, maxTokens, prefixMode, standardPrefix, customPrefix, language, userInput, similarCommits);
		} else {
			vscode.window.showErrorMessage(t('errNoApiKeyConfig'));
			return [];
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : t('errUnknown');
		if (msg.includes('401') || msg.includes('403') || msg.includes('Authentication') || msg.includes('auth')) {
			vscode.window.showErrorMessage(t('errInvalidKey'));
		} else if (msg.includes('insufficient_quota') || msg.includes('quota') || msg.includes('402')) {
			vscode.window.showErrorMessage(t('errQuotaExceeded'));
		} else {
			vscode.window.showErrorMessage(t('msgGenerationFailed', msg));
		}
		console.error('[BlueCome]', error);
		return [];
	}
};

// ── Build chat context from git diff + history ──────────

export async function buildChatContext(): Promise<string> {
	try {
		const repository = getMainRepository();
		const [diff, commits] = await Promise.all([
			(async () => {
				try {
					let d = await repository.diff(true);
					if (!d?.trim()) d = await repository.diff(false);
					return d || '';
				} catch { return ''; }
			})(),
			(async () => {
				try { return await repository.log({ maxEntries: 5 }); }
				catch { return []; }
			})(),
		]);
		let ctx = '';
		if (diff?.trim()) {
			const maxDiffLen = 2000;
			const truncated = diff.length > maxDiffLen;
			const diffContent = truncated ? diff.substring(0, maxDiffLen) + '\n... (truncated, ' + diff.length + ' chars total)' : diff;
			ctx += `Current git diff:\n\`\`\`diff\n${diffContent}\n\`\`\``;
		}
		if (commits.length > 0) {
			ctx += '\n\nRecent commits:\n' + commits.map(c => `  ${c.hash.substring(0, 7)} ${c.message.split('\n')[0]}`).join('\n');
		}
		return ctx || 'No git changes detected.';
	} catch {
		return 'No git repository context available.';
	}
}

// ── Streaming chat AI call ──────────────────────────────

export interface ChatStreamResult {
	text: string;
	toolCalls: { id: string; name: string; arguments: string }[];
}

export async function callChatStream(
	messages: ChatMessage[],
	providerCfg: ProviderConfig,
	temperature: number,
	maxTokens: number | undefined,
	onToken: (token: string) => void,
	onReasoning?: (token: string) => void,
	options?: { tools?: Record<string, unknown>[]; signal?: AbortSignal },
): Promise<ChatStreamResult> {
	const apiUrl = providerCfg.baseUrl.replace(/\/+$/, '');
	const url = apiUrl.endsWith('/v1') ? `${apiUrl}/chat/completions` : `${apiUrl}/v1/chat/completions`;
	const body: Record<string, unknown> = {
		model: providerCfg.model,
		messages,
		temperature: Math.max(0, Math.min(2, temperature)),
		stream: true,
	};
	if (maxTokens != null && maxTokens > 0) {
		body.max_tokens = maxTokens;
	}
	if (options?.tools && options.tools.length > 0) {
		body.tools = options.tools;
	}

	const internal = new AbortController();
	const externalSignal = options?.signal;
	const fetchTimeout = setTimeout(() => internal.abort(), 60000);

	let externalAbortHandler: (() => void) | null = null;
	if (externalSignal && !externalSignal.aborted) {
		externalAbortHandler = () => internal.abort();
		externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
	} else if (externalSignal?.aborted) {
		internal.abort();
	}

	let response: any;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${providerCfg.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: internal.signal,
		});
	} catch (e) {
		clearTimeout(fetchTimeout);
		if (externalAbortHandler) {
			externalSignal?.removeEventListener('abort', externalAbortHandler);
			externalAbortHandler = null;
		}
		if (externalSignal?.aborted) throw new Error('Stopped by user');
		throw e;
	}
	clearTimeout(fetchTimeout);
	if (!response.ok) {
		if (externalAbortHandler) {
			externalSignal?.removeEventListener('abort', externalAbortHandler);
			externalAbortHandler = null;
		}
		const errText = await response.text().catch(() => '');
		throw new Error(`Chat API error ${response.status}: ${errText || response.statusText}`);
	}
	let fullText = '';
	let buffer = '';
	let toolCallAccum: Record<number, { id: string; name: string; args: string }> = {};

	const processLine = (line: string) => {
		if (!line.startsWith('data: ')) return;
		const data = line.slice(6).trim();
		if (data === '[DONE]') return;
		try {
			const parsed = JSON.parse(data);
			const choice = parsed.choices?.[0];
			if (!choice) return;
			const delta = choice.delta;
			if (!delta) return;
			const reasoning = delta.reasoning_content || '';
			if (reasoning && onReasoning) onReasoning(reasoning);
			const content = delta.content || '';
			if (content) {
				fullText += content;
				onToken(content);
			}
			const tcs = delta.tool_calls;
			if (Array.isArray(tcs)) {
				for (const tc of tcs) {
					if (tc == null || tc.index == null) continue;
					const slot = toolCallAccum[tc.index] || (toolCallAccum[tc.index] = { id: '', name: '', args: '' });
					if (tc.id) slot.id = tc.id;
					if (tc.function?.name) slot.name = tc.function.name;
					if (tc.function?.arguments) slot.args += tc.function.arguments;
				}
			}
		} catch {}
	};

	const processChunk = (chunk: string) => {
		buffer += chunk;
		const parts = buffer.split('\n\n');
		buffer = parts.pop() || '';
		for (const part of parts) {
			for (const line of part.split('\n')) {
				processLine(line);
			}
		}
	};

	const stream = response.body as any;
	return new Promise<ChatStreamResult>((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(totalTimeout);
			if (externalAbortHandler) {
				externalSignal?.removeEventListener('abort', externalAbortHandler);
				externalAbortHandler = null;
			}
		};

		const totalTimeout = setTimeout(() => {
			internal.abort();
			cleanup();
			reject(new Error('Chat stream timed out after 60s'));
		}, 60000);

		const finish = () => {
			cleanup();
			const toolCalls = Object.values(toolCallAccum).map(tc => ({ id: tc.id, name: tc.name, arguments: tc.args }));
			resolve({ text: fullText, toolCalls });
		};

		if (stream && typeof stream.on === 'function') {
			stream.on('data', (chunk: Buffer) => processChunk(chunk.toString()));
			stream.on('end', finish);
			stream.on('error', (err: Error) => { console.log(`[BlueCome][diag] stream error: ${err.message} (fullTextLen=${fullText.length})`); cleanup(); reject(err); });
		} else if (stream && typeof stream.getReader === 'function') {
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			(function read() {
				reader.read().then(({ done, value }: { done: boolean; value?: Uint8Array }) => {
					if (done) { finish(); return; }
					if (value) processChunk(decoder.decode(value, { stream: true }));
					read();
				}).catch((err: Error) => { cleanup(); reject(err); });
			})();
		} else {
			cleanup();
			reject(new Error('Response body is not a readable stream'));
		}
	});
}
// ── 工具函数 ──────────────────────────────────────────

export const removeSurroundingQuotes = (input: string): string => {
	if (input.startsWith('"') && input.endsWith('"')) {
		return input.slice(1, -1);
	}
	return input;
};

export const capitalize = (input: string): string => {
	const cleaned = removeSurroundingQuotes(input);
	if (!cleaned) {
		return '';
	}
	return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
};

export const documentFilters: Array<vscode.DocumentFilter | string> = [
	{ language: 'scminput' },
	{ language: 'git-commit' },
	{ scheme: 'git-commit' },
];