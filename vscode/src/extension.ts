import * as vscode from 'vscode';
import { documentFilters, getMainRepository, fetchCommitMessage, capitalize, setMemoryConfig, MemoryCache, fetchModels, testApiSpeed, PROVIDER_BASE_URLS, getCommitHistory, getCommitChanges, callChatStream, buildChatContext, searchCommitsBM25 } from './utils';
import { InlineCommitCompletionItemProvider, CommitCompletionItemProvider, COMMIT_TYPES } from './CommitCompletionItemProvider';
import type { GitExtension } from './api/git';
import { t } from './i18n';
import { hashWorkspacePath } from './agent/workspace';
import type { ChatMessage } from './agent/context';
import { runChat, ToolEvent } from './agent/toolRunner';
import { listTools } from './agent/tools';

// SCM 输入框补全的共享状态
let scmAiBusy = false;
// 模块级别：追踪活动的 chat abort，供 deactivate 清理
let _activeChatAbort: AbortController | null = null;

/// 生成多条候选并弹出选择框（userInput 存在时进入"输入补全"模式）
async function generateAndPick(overrideConfig?: MemoryCache, userInput?: string) {
	const cfg = vscode.workspace.getConfiguration('cmg');
	const count = overrideConfig?.suggestionCount || cfg.suggestionCount || 5;
	// AI 生成中的状态栏提示
	const statusMsg = vscode.window.setStatusBarMessage('$(sync~spin) ' + t('msgGenerating'));

	try {
		const messages = await fetchCommitMessage(count, overrideConfig, userInput);
		statusMsg.dispose();
		if (!messages || messages.length === 0) return;

		const items = messages.map((m, i) => ({
			label: `${i + 1}. ${capitalize(userInput ? userInput + m : m)}`,
			description: '',
			detail: m,
		}));

		const pick = await vscode.window.showQuickPick(items, {
			placeHolder: t('msgSelectCommit', items.length),
			matchOnDetail: true,
		});

		if (pick) {
			const finalMsg = userInput ? userInput + pick.detail : pick.detail;
			try { getMainRepository().inputBox.value = finalMsg; } catch {}
			vscode.window.showInformationMessage(t('msgSelected'));
		}
	} catch (error) {
		statusMsg.dispose();
		const msg = error instanceof Error ? error.message : t('errUnknown');
		vscode.window.showErrorMessage(t('msgGenerationFailed', msg));
	}
}

class SettingsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'hisccs.settingsView';

	constructor(private readonly _extensionUri: vscode.Uri) {}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		const nonce = getNonce();
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
		webviewView.webview.html = buildHtml(nonce, webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (msg) => {
			if (msg.type === 'save' || msg.type === 'uiSave') {
				const cfg = vscode.workspace.getConfiguration('cmg');
				setMemoryConfig(msg);
				await cfg.update('apiKey', msg.apiKey, vscode.ConfigurationTarget.Global);
				await cfg.update('provider', msg.provider, vscode.ConfigurationTarget.Global);
				await cfg.update('baseUrl', msg.baseUrl, vscode.ConfigurationTarget.Global);
				await cfg.update('modelName', msg.modelName, vscode.ConfigurationTarget.Global);
				await cfg.update('apiEndpoint', msg.apiEndpoint, vscode.ConfigurationTarget.Global);
				await cfg.update('AccordingHistoryOrNot', !!msg.withHistory, vscode.ConfigurationTarget.Global);
				await cfg.update('temperature', msg.temperature ?? 0.7, vscode.ConfigurationTarget.Global);
				await cfg.update('max_tokens', msg.maxTokens ?? 200, vscode.ConfigurationTarget.Global);
				await cfg.update('suggestionCount', msg.suggestionCount ?? 5, vscode.ConfigurationTarget.Global);
				await cfg.update('prefixMode', msg.prefixMode || 'standard', vscode.ConfigurationTarget.Global);
				await cfg.update('standardPrefix', msg.standardPrefix || '', vscode.ConfigurationTarget.Global);
				await cfg.update('customPrefix', msg.customPrefix || '', vscode.ConfigurationTarget.Global);
				await cfg.update('language', msg.language || 'auto', vscode.ConfigurationTarget.Global);
				await cfg.update('uiLanguage', msg.uiLanguage || 'auto', vscode.ConfigurationTarget.Global);
				if (msg.type === 'uiSave') {
					webviewView.webview.html = buildHtml(getNonce(), webviewView.webview);
				} else {
					vscode.window.showInformationMessage(t('msgSaved'));
					webviewView.webview.postMessage({ type: 'saved' });
				}
			}
			if (msg.type === 'generate') {
				const overrideConfig: MemoryCache = {
					apiKey: msg.apiKey || '',
					provider: msg.provider || 'deepseek',
					baseUrl: msg.baseUrl || '',
					modelName: msg.modelName || '',
					apiEndpoint: msg.apiEndpoint || '',
					withHistory: !!msg.withHistory,
					temperature: typeof msg.temperature === 'number' ? msg.temperature : 0.7,
					maxTokens: typeof msg.maxTokens === 'number' ? msg.maxTokens : 200,
					suggestionCount: typeof msg.suggestionCount === 'number' ? msg.suggestionCount : 5,
					prefixMode: msg.prefixMode || 'standard',
					standardPrefix: msg.standardPrefix || '',
					customPrefix: msg.customPrefix || '',
					language: msg.language || 'auto',
					uiLanguage: msg.uiLanguage || 'auto',
				};
				setMemoryConfig(overrideConfig);
				await generateAndPick(overrideConfig);
				webviewView.webview.postMessage({ type: 'done' });
				return;
			}
			if (msg.type === 'fetchModels') {
				const apiKey = msg.apiKey || vscode.workspace.getConfiguration('cmg').apiKey || '';
				const baseUrl = msg.baseUrl || PROVIDER_BASE_URLS[msg.provider] || vscode.workspace.getConfiguration('cmg').baseUrl || '';
				if (!apiKey) { webviewView.webview.postMessage({ type: 'models', error: t('errNoApiKey') }); return; }
				if (!baseUrl) { webviewView.webview.postMessage({ type: 'models', error: t('errNoBaseUrl') }); return; }
				try {
					const models = await fetchModels(apiKey, baseUrl);
					webviewView.webview.postMessage({ type: 'models', models });
				} catch (e) {
					const msg = e instanceof Error ? e.message : t('errUnknown');
					webviewView.webview.postMessage({ type: 'models', error: msg });
				}
				return;
			}
			if (msg.type === 'testSpeed') {
				const apiKey = msg.apiKey || vscode.workspace.getConfiguration('cmg').apiKey || '';
				const baseUrl = msg.baseUrl || PROVIDER_BASE_URLS[msg.provider] || vscode.workspace.getConfiguration('cmg').baseUrl || '';
				if (!apiKey) { webviewView.webview.postMessage({ type: 'speedResult', error: t('errNoApiKey') }); return; }
				if (!baseUrl) { webviewView.webview.postMessage({ type: 'speedResult', error: t('errNoBaseUrl') }); return; }
				try {
					const result = await testApiSpeed(apiKey, baseUrl);
					webviewView.webview.postMessage({ type: 'speedResult', ...result });
				} catch (e) {
					const msg = e instanceof Error ? e.message : t('errUnknown');
					webviewView.webview.postMessage({ type: 'speedResult', error: msg });
				}
				return;
			}
			if (msg.type === 'openUrl') {
				vscode.env.openExternal(vscode.Uri.parse(msg.url));
				return;
			}
			if (msg.type === 'openHistory') {
				vscode.commands.executeCommand('cmg-vscode.viewCommitHistory');
				return;
			}
			if (msg.type === 'openChat') {
				vscode.commands.executeCommand('cmg-vscode.openChat');
				return;
			}
		});
	}
}

function buildHtml(nonce: string, webview: vscode.Webview): string {
	const cfg = vscode.workspace.getConfiguration('cmg');
	const ak = cfg.apiKey || '';
	const prov = cfg.provider || 'deepseek';
	const bu = cfg.baseUrl || '';
	const mn = cfg.modelName || '';
	const ep = cfg.apiEndpoint || '';
	const hist = cfg.AccordingHistoryOrNot || false;
	const temp = cfg.temperature ?? 0.7;
	const tokens = cfg.max_tokens ?? 200;
	const sc = cfg.suggestionCount ?? 5;
	const prefixMode = cfg.prefixMode || 'standard';
	const stdPrefix = cfg.standardPrefix || '';
	const custPrefix = cfg.customPrefix || '';
	const uiLang = cfg.uiLanguage || 'auto';
	const lang = cfg.language || 'auto';

	return /* html */`<!DOCTYPE html>
<html${/*lang*/''}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
</head>
<body style="padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:var(--vscode-foreground);">

<div id="apiStatus" style="display:flex;align-items:center;gap:6px;font-size:12px;padding:6px 8px;border-radius:3px;background:var(--vscode-inputValidation-infoBackground);margin-bottom:12px;">
	<span style="width:7px;height:7px;border-radius:50%;display:inline-block;background:${ak?'#2ea043':'#da3633'};"></span>
	<span>${ak ? t('apiConfigured') : t('apiMissing')}</span>
</div>

<div style="margin-bottom:12px;">
<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--vscode-descriptionForeground);margin-bottom:6px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:4px;">${t('sectionAiModel')}</div>

<div style="margin-bottom:8px;">
<label style="display:block;font-size:11px;margin-bottom:3px;">${t('labelProvider')}</label>
<select id="prov" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;">
<option value="deepseek" ${prov==='deepseek'?'selected':''}>${t('providerDeepseek')}</option>
<option value="qwen" ${prov==='qwen'?'selected':''}>${t('providerQwen')}</option>
<option value="openai" ${prov==='openai'?'selected':''}>${t('providerOpenai')}</option>
</select>
</div>

<div style="margin-bottom:8px;">
<label style="display:block;font-size:11px;margin-bottom:3px;">${t('labelApiKey')}</label>
<input id="key" type="password" value="${ak}" placeholder="sk-xxx" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;">
</div>

<div style="margin-bottom:8px;">
<label style="display:block;font-size:11px;margin-bottom:3px;">${t('labelBaseUrl')}</label>
<input id="baseUrl" type="url" value="${bu}" placeholder="${t('placeholderBaseUrl')}" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;">
</div>

<div style="margin-bottom:6px;">
<div style="display:flex;gap:6px;">
<button id="btnFetchModels" style="flex:1;padding:5px 0;font-size:11px;font-weight:500;border:none;border-radius:3px;cursor:pointer;background:var(--vscode-button-secondaryBackground,var(--vscode-button-background));color:var(--vscode-button-secondaryForeground,var(--vscode-button-foreground));">${t('btnFetchModels')}</button>
<button id="btnTestSpeed" style="flex:1;padding:5px 0;font-size:11px;font-weight:500;border:none;border-radius:3px;cursor:pointer;background:var(--vscode-button-secondaryBackground,var(--vscode-button-background));color:var(--vscode-button-secondaryForeground,var(--vscode-button-foreground));">${t('btnTestSpeed')}</button>
</div>
<select id="model" style="width:100%;margin-top:6px;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;">
<option value="" ${!mn?'selected':''}>${t('placeholderModel')}</option>
</select>
<input id="modelInput" type="text" value="${mn}" placeholder="${t('placeholderModelInput')}" style="width:100%;margin-top:4px;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;">
<div id="modelHelp" style="font-size:10.5px;color:var(--vscode-descriptionForeground);margin-top:2px;"></div>
</div>

<div style="margin-bottom:8px;">
<label style="display:block;font-size:11px;margin-bottom:3px;">${t('labelEndpoint')} <span style="color:var(--vscode-descriptionForeground);font-weight:400;">(${t('labelOptional')})</span></label>
<input id="ep" type="url" value="${ep}" placeholder="${t('placeholderEndpoint')}" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;">
</div>
</div>

<div style="margin-bottom:12px;">
<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--vscode-descriptionForeground);margin-bottom:6px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:4px;">${t('sectionParams')}</div>

<div style="display:flex;gap:8px;">
<div style="flex:1;margin-bottom:8px;">
<label style="display:block;font-size:11px;margin-bottom:3px;">${t('labelTemperature')}</label>
<input id="temp" type="number" value="${temp}" min="0" max="2" step="0.1" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;">
</div>
<div style="flex:1;margin-bottom:8px;">
<label style="display:block;font-size:11px;margin-bottom:3px;">${t('labelCount')}</label>
<input id="sc" type="number" value="${sc}" min="2" max="10" step="1" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;">
</div>
</div>

<div style="display:flex;gap:8px;">
<div style="flex:1;margin-bottom:8px;">
<label style="display:block;font-size:11px;margin-bottom:3px;">${t('labelMaxTokens')}</label>
<input id="mt" type="number" value="${tokens}" min="50" max="2000" step="10" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;">
</div>
<div style="flex:1;margin-bottom:8px;"></div>
</div>

<div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
<input id="hist" type="checkbox" ${hist?'checked':''} style="width:auto;">
<label for="hist" style="font-size:12px;cursor:pointer;">${t('labelHistory')}</label>
</div>

<div style="margin-top:10px;">
<label style="display:block;font-size:11px;margin-bottom:3px;">${t('labelPrefixMode')}</label>
<select id="prefixMode" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;">
<option value="standard" ${prefixMode==='standard'?'selected':''}>${t('optionStandard')}</option>
<option value="custom" ${prefixMode==='custom'?'selected':''}>${t('optionCustom')}</option>
</select>

<select id="standardPrefix" style="width:100%;margin-top:4px;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;${prefixMode==='standard'?'':'display:none;'}">
<option value="" ${!stdPrefix?'selected':''}>${t('optionAutoSelect')}</option>
<option value="feat" ${stdPrefix==='feat'?'selected':''}>${t('optionFeat')}</option>
<option value="fix" ${stdPrefix==='fix'?'selected':''}>${t('optionFix')}</option>
<option value="docs" ${stdPrefix==='docs'?'selected':''}>${t('optionDocs')}</option>
<option value="style" ${stdPrefix==='style'?'selected':''}>${t('optionStyle')}</option>
<option value="refactor" ${stdPrefix==='refactor'?'selected':''}>${t('optionRefactor')}</option>
<option value="perf" ${stdPrefix==='perf'?'selected':''}>${t('optionPerf')}</option>
<option value="test" ${stdPrefix==='test'?'selected':''}>${t('optionTest')}</option>
<option value="chore" ${stdPrefix==='chore'?'selected':''}>${t('optionChore')}</option>
<option value="revert" ${stdPrefix==='revert'?'selected':''}>${t('optionRevert')}</option>
</select>

<div id="customPrefixArea" style="margin-top:4px;${prefixMode==='custom'?'':'display:none;'}">
<input id="customPrefixInput" type="text" value="${custPrefix}" placeholder="${t('placeholderCustomPrefix')}" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;">
<label style="font-size:10.5px;color:var(--vscode-descriptionForeground);margin-top:2px;">${t('helpCustomPrefix')}</label>
</div>
</div>

<div style="margin-top:8px;">
<label style="display:block;font-size:11px;margin-bottom:3px;">${t('labelLanguage')}</label>
<select id="langSelect" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;">
<option value="auto" ${lang==='auto'?'selected':''}>${t('optionLangAuto')}</option>
<option value="zh" ${lang==='zh'?'selected':''}>${t('optionLangZh')}</option>
<option value="en" ${lang==='en'?'selected':''}>${t('optionLangEn')}</option>
<option value="ja" ${lang==='ja'?'selected':''}>${t('optionLangJa')}</option>
<option value="ru" ${lang==='ru'?'selected':''}>${t('optionLangRu')}</option>
<option value="fr" ${lang==='fr'?'selected':''}>${t('optionLangFr')}</option>
<option value="de" ${lang==='de'?'selected':''}>${t('optionLangDe')}</option>
</select>
</div>

	<div style="margin-top:8px;">
	<label style="display:block;font-size:11px;margin-bottom:3px;">${t('labelUiLanguage')}</label>
	<select id="uiLangSelect" style="width:100%;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:3px;box-sizing:border-box;">
	<option value="auto" ${uiLang==='auto'?'selected':''}>${t('optionLangAuto')}</option>
	<option value="zh" ${uiLang==='zh'?'selected':''}>${t('optionLangZh')}</option>
	<option value="en" ${uiLang==='en'?'selected':''}>${t('optionLangEn')}</option>
	<option value="ja" ${uiLang==='ja'?'selected':''}>${t('optionLangJa')}</option>
	<option value="ru" ${uiLang==='ru'?'selected':''}>${t('optionLangRu')}</option>
	<option value="fr" ${uiLang==='fr'?'selected':''}>${t('optionLangFr')}</option>
	<option value="de" ${uiLang==='de'?'selected':''}>${t('optionLangDe')}</option>
	</select>
	</div>

	<div style="margin-top:4px;display:flex;gap:6px;align-items:center;">
	<button id="btnReloadUi" style="flex:1;padding:5px 0;font-size:11px;font-weight:500;border:none;border-radius:3px;cursor:pointer;background:var(--vscode-button-secondaryBackground,var(--vscode-button-background));color:var(--vscode-button-secondaryForeground,var(--vscode-button-foreground));">${t('btnApplyUiLang')}</button>
	</div>
</div>

<div id="log" style="font-size:11px;padding:6px;border-radius:3px;display:none;margin-bottom:8px;"></div>

<button id="btnHistory" style="padding:8px 0;font-size:13px;font-weight:500;border:none;border-radius:3px;cursor:pointer;width:100%;margin-bottom:8px;background:var(--vscode-button-secondaryBackground,var(--vscode-button-background));color:var(--vscode-button-secondaryForeground,var(--vscode-button-foreground));">${t('btnViewHistory')}</button>

<button id="btnChat" style="padding:8px 0;font-size:13px;font-weight:500;border:none;border-radius:3px;cursor:pointer;width:100%;margin-bottom:8px;background:var(--vscode-button-secondaryBackground,var(--vscode-button-background));color:var(--vscode-button-secondaryForeground,var(--vscode-button-foreground));">${t('btnOpenChat')}</button>

<div style="display:flex;flex-direction:column;gap:6px;">
<button id="btnSave" style="padding:8px 0;font-size:13px;font-weight:500;border:none;border-radius:3px;cursor:pointer;width:100%;background:var(--vscode-button-background);color:var(--vscode-button-foreground);">${t('btnSave')}</button>
<button id="btnGen" style="padding:10px 0;font-size:14px;font-weight:500;border:none;border-radius:3px;cursor:pointer;width:100%;background:#2ea043;color:white;">${t('btnGenerate')}</button>
</div>

<script nonce="${nonce}">
try {
(function(){
	const LOCALE = ${JSON.stringify({
		loadingGenerating: t('loadingGenerating'),
		loadingRequestingAi: t('loadingRequestingAi'),
		loadingFetching: t('loadingFetching'),
		loadingFetchingModels: t('loadingFetchingModels'),
		loadingTesting: t('loadingTesting'),
		loadingTestingSpeed: t('loadingTestingSpeed'),
		doneSelectInPopup: t('doneSelectInPopup'),
		doneConfigSaved: t('doneConfigSaved'),
		doneModelsFetched: t('doneModelsFetched'),
		doneModelsHelp: t('doneModelsHelp'),
		doneSpeedResult: t('doneSpeedResult'),
		doneSpeedFailed: t('doneSpeedFailed'),
		placeholderModel: t('placeholderModel'),
		btnGenerate: t('btnGenerate'),
	})};

	var api = acquireVsCodeApi();

	function getVals(){
		return {
			apiKey: document.getElementById('key').value.trim(),
			provider: document.getElementById('prov').value,
			baseUrl: document.getElementById('baseUrl').value.trim(),
			modelName: document.getElementById('modelInput').value.trim(),
			apiEndpoint: document.getElementById('ep').value.trim(),
			withHistory: document.getElementById('hist').checked,
			temperature: parseFloat(document.getElementById('temp').value) || 0.7,
			maxTokens: parseInt(document.getElementById('mt').value) || 200,
			suggestionCount: parseInt(document.getElementById('sc').value) || 5,
			prefixMode: document.getElementById("prefixMode").value,
			standardPrefix: document.getElementById("standardPrefix").value,
			customPrefix: document.getElementById("customPrefixInput").value.trim(),
			language: document.getElementById("langSelect").value,
			uiLanguage: document.getElementById("uiLangSelect").value,
		};
	}

	document.getElementById('btnReloadUi').onclick = function(){
		api.postMessage({ type: 'uiSave', ...getVals() });
	};
		document.getElementById('btnHistory').onclick = function(){
			api.postMessage({ type: 'openHistory' });
		};
		document.getElementById('btnChat').onclick = function(){
			api.postMessage({ type: 'openChat' });
		};
	document.getElementById('btnGen').onclick = function(){
		var btn = this;
		btn.disabled = true; btn.innerHTML = LOCALE.loadingGenerating;
		var el = document.getElementById('log');
		el.style.display = 'block'; el.style.background = 'var(--vscode-inputValidation-infoBackground)'; el.textContent = LOCALE.loadingRequestingAi;
		api.postMessage({ type: 'generate', ...getVals() });
	};

	document.getElementById('btnSave').onclick = function(){
		api.postMessage({ type: 'save', ...getVals() });
	};

	document.getElementById('btnFetchModels').onclick = function(){
		var btn = this;
		var orig = btn.textContent;
		btn.disabled = true; btn.textContent = LOCALE.loadingFetching;
		var el = document.getElementById('log');
		el.style.display = 'block'; el.style.background = 'var(--vscode-inputValidation-infoBackground)'; el.textContent = LOCALE.loadingFetchingModels;
		api.postMessage({ type: 'fetchModels', apiKey: document.getElementById('key').value.trim(), baseUrl: document.getElementById('baseUrl').value.trim(), provider: document.getElementById('prov').value });
		setTimeout(function(){ btn.disabled = false; btn.textContent = orig; }, 3000);
	};

	document.getElementById('btnTestSpeed').onclick = function(){
		var btn = this;
		var orig = btn.textContent;
		btn.disabled = true; btn.textContent = LOCALE.loadingTesting;
		var el = document.getElementById('log');
		el.style.display = 'block'; el.style.background = 'var(--vscode-inputValidation-infoBackground)'; el.textContent = LOCALE.loadingTestingSpeed;
		api.postMessage({ type: 'testSpeed', apiKey: document.getElementById('key').value.trim(), baseUrl: document.getElementById('baseUrl').value.trim(), provider: document.getElementById('prov').value });
		setTimeout(function(){ btn.disabled = false; btn.textContent = orig; }, 3000);
	};

	document.getElementById('model').onchange = function(){
		if(this.value){
			document.getElementById('modelInput').value = this.value;
		}
	};

	document.getElementById('prefixMode').onchange = function(){
		var mode = this.value;
		document.getElementById('standardPrefix').style.display = mode === 'standard' ? '' : 'none';
		document.getElementById('customPrefixArea').style.display = mode === 'custom' ? '' : 'none';
	};

	window.addEventListener('message', function(e){
		var d = e.data;
		var log = document.getElementById('log');
		var btn = document.getElementById('btnGen');
		var help = document.getElementById('modelHelp');
		if(d.type === 'done'){
			btn.disabled = false; btn.innerHTML = LOCALE.btnGenerate;
			log.style.display = 'block'; log.style.background = 'rgba(46,160,67,0.15)'; log.textContent = LOCALE.doneSelectInPopup;
		} else if(d.type === 'err'){
			btn.disabled = false; btn.innerHTML = LOCALE.btnGenerate;
			log.style.display = 'block'; log.style.background = 'rgba(218,54,51,0.15)'; log.textContent = '✗ ' + d.text;
		} else if(d.type === 'saved'){
			log.style.display = 'block'; log.style.background = 'rgba(46,160,67,0.15)'; log.textContent = LOCALE.doneConfigSaved
		} else if(d.type === 'models'){
			var sel = document.getElementById('model');
			sel.innerHTML = '<option value="">' + LOCALE.placeholderModel + '</option>';
			if(d.error){
				log.style.display = 'block'; log.style.background = 'rgba(218,54,51,0.15)'; log.textContent = '✗ ' + d.error;
			} else if(d.models && d.models.length){
				d.models.forEach(function(m){
					var opt = document.createElement('option');
					opt.value = m.id; opt.textContent = m.id;
					sel.appendChild(opt);
				});
				log.style.display = 'block'; log.style.background = 'rgba(46,160,67,0.15)'; log.textContent = LOCALE.doneModelsFetched.replace('{0}', d.models.length);
				help.textContent = LOCALE.doneModelsHelp.replace('{0}', d.models.length);
			}
		} else if(d.type === 'speedResult'){
			if(d.error){
				log.style.display = 'block'; log.style.background = 'rgba(218,54,51,0.15)'; log.textContent = LOCALE.doneSpeedFailed.replace('{0}', d.error);
			} else {
				log.style.display = 'block'; log.style.background = 'rgba(46,160,67,0.15)';
				log.textContent = LOCALE.doneSpeedResult.replace('{0}', d.status).replace('{1}', d.ms) + (d.ms < 500 ? ' 🚀' : d.ms < 1500 ? ' 👍' : ' 🐢');
			}
		}
	});
	console.log('[HisCCS] webview OK');
})();
} catch(e){ console.error('[HisCCS] webview error:', e); }
</script>
</body>
</html>`;
}

function getNonce(): string {
	let s = '';
	const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 64; i++) s += c[Math.floor(Math.random() * 64)];
	return s;
}

function buildHistoryHtml(nonce: string, webview: vscode.Webview): string {
	return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;}
#loading{text-align:center;padding:40px 16px;color:var(--vscode-descriptionForeground);}
.commit-item{border-bottom:1px solid var(--vscode-panel-border);padding:10px 12px;cursor:pointer;}
.commit-item:hover{background:var(--vscode-list-hoverBackground);}
.commit-meta{display:flex;gap:12px;align-items:center;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:4px;flex-wrap:wrap;}
.commit-hash{font-family:monospace;font-weight:600;color:var(--vscode-textLink-foreground);}
.commit-date{white-space:nowrap;}
.commit-author{flex-shrink:0;}
.commit-msg{font-size:13px;line-height:1.4;word-break:break-word;}
.commit-detail{display:none;margin-top:8px;padding:8px 10px;background:var(--vscode-inputValidation-infoBackground);border-radius:4px;font-size:12px;}
.commit-detail.open{display:block;}
.change-row{display:flex;align-items:center;gap:8px;padding:2px 0;font-family:monospace;font-size:12px;}
.change-status{display:inline-flex;align-items:center;justify-content:center;width:22px;font-weight:700;font-size:10px;padding:1px 0;border-radius:2px;flex-shrink:0;}
.change-status.A{background:rgba(46,160,67,0.2);color:#2ea043;}
.change-status.M{background:rgba(217,166,0,0.2);color:#d9a600;}
.change-status.D{background:rgba(218,54,51,0.2);color:#da3633;}
.change-status.R{background:rgba(88,166,255,0.2);color:#58a6ff;}
.change-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.change-link{cursor:pointer;text-decoration:underline;color:var(--vscode-textLink-foreground);}
.change-link:hover{color:var(--vscode-textLink-activeForeground);}
.detail-loading{color:var(--vscode-descriptionForeground);font-style:italic;padding:4px 0;}
#error{display:none;padding:16px;color:var(--vscode-errorForeground);background:rgba(218,54,51,0.1);border-radius:4px;margin:16px;text-align:center;}
</style>
</head>
<body>
<div id="loading">${t('loadingCommits')}</div>
<div id="error"></div>
<div style="padding:8px 16px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);">
<input id="searchInput" type="text" placeholder="🔍 BM25 search commits..." style="width:100%;padding:6px 10px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:4px;box-sizing:border-box;outline:none;">
</div>
<div id="commitList" style="display:none;"></div>

<script nonce="${nonce}">
(function(){
	var LOCALE = ${JSON.stringify({
		loadingCommitDetail: t('loadingCommitDetail'),
		initialCommit: t('initialCommit'),
		statusAdded: t('statusAdded'),
		statusModified: t('statusModified'),
		statusDeleted: t('statusDeleted'),
		statusRenamed: t('statusRenamed'),
		sectionFileChanges: t('sectionFileChanges'),
	})};

	var api = acquireVsCodeApi();
	api.postMessage({ type: 'ready' });

	var searchEl = document.getElementById('searchInput');
	var searchTimer = null;
	if(searchEl){
		searchEl.addEventListener('input', function(){
			if(searchTimer) clearTimeout(searchTimer);
			searchTimer = setTimeout(function(){
				api.postMessage({ type: 'search', query: searchEl.value.trim() });
			}, 250);
		});
	}

	window.addEventListener('message', function(e){
		var d = e.data;
		if(d.type === 'commits'){ renderList(d.commits); }
		else if(d.type === 'searchResults'){ renderList(d.commits); }
		else if(d.type === 'changes'){ renderDetail(d.hash, d.changes); }
		else if(d.type === 'error'){ showError(d.text); }
	});

	function renderList(commits){
		var el = document.getElementById('loading');
		el.style.display = 'none';
		document.getElementById('error').style.display = 'none';
		var list = document.getElementById('commitList');
		list.style.display = '';
		list.innerHTML = '';
		commits.forEach(function(c){
			var item = document.createElement('div');
			item.className = 'commit-item';
			var dateStr = c.authorDate ? new Date(c.authorDate).toLocaleString() : '';
			item.innerHTML =
				'<div class="commit-meta">' +
					'<span class="commit-hash">' + esc(c.shortHash) + '</span>' +
					'<span class="commit-author">' + esc(c.authorName) + '</span>' +
					'<span class="commit-date">' + esc(dateStr) + '</span>' +
				'</div>' +
				'<div class="commit-msg">' + esc(c.message) + '</div>' +
				'<div class="commit-detail" id="d-' + c.hash + '" data-commit-hash="' + c.hash + '"></div>';
			item.onclick = function(){
				var detail = document.getElementById('d-' + c.hash);
				var wasOpen = detail.classList.contains('open');
				document.querySelectorAll('.commit-detail.open').forEach(function(el){ el.classList.remove('open'); });
				if(!wasOpen){
					detail.classList.add('open');
					if(!detail.dataset.loaded && !detail.dataset.loading){
						detail.dataset.loading = '1';
						detail.innerHTML = '<div class="detail-loading">' + LOCALE.loadingCommitDetail + '</div>';
						api.postMessage({ type: 'fetchChanges', hash: c.hash });
					}
				}
			};
			list.appendChild(item);
		});
	}

	function renderDetail(hash, changes){
		var el = document.getElementById('d-' + hash);
		if(!el) return;
		el.dataset.loaded = '1';
		if(!changes || changes.length === 0){
			el.innerHTML = '<div style="color:var(--vscode-descriptionForeground);padding:4px 0;font-style:italic;">' + LOCALE.initialCommit + '</div>';
			return;
		}
		var html = changes.map(function(c){
			var st = c.status;
			var stLabel = LOCALE['status' + st.charAt(0).toUpperCase() + st.slice(1)] || st;
			return '<div class="change-row"><span class="change-status ' + st.charAt(0).toUpperCase() + '">' + st.charAt(0).toUpperCase() + '</span><span class="change-path change-link" title="' + esc(stLabel) + ': ' + esc(c.file) + '" data-path="' + esc(c.file) + '">' + esc(c.file) + '</span></div>';
		}).join('');
		el.innerHTML = '<div style="font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--vscode-descriptionForeground);margin-bottom:4px;">' + LOCALE.sectionFileChanges + '</div>' + html;
		el.querySelectorAll('.change-link').forEach(function(node){
			node.onclick = function(ev){
				ev.stopPropagation();
				api.postMessage({ type: 'openFile', hash: el.dataset.commitHash || '', path: node.getAttribute('data-path') });
			};
		});
	}

	function showError(text){
		document.getElementById('loading').style.display = 'none';
		var err = document.getElementById('error');
		err.textContent = text; err.style.display = '';
	}

	function esc(s){ return typeof s === 'string' ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }
})();
</script>
</body>
</html>`;
}



function buildChatHtml(nonce: string, webview: vscode.Webview): string {
	return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
*{box-sizing:border-box;}
body{padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;display:flex;flex-direction:column;height:100vh;}
#header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);flex-shrink:0;}
#header h2{margin:0;font-size:14px;font-weight:600;}
#messages{flex:1;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;gap:6px;}
#inputArea{flex-shrink:0;padding:6px 12px 10px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);}
#inputRow{display:flex;gap:6px;align-items:flex-end;}
#chatInput{flex:1;padding:7px 10px;font-size:13px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:6px;resize:none;outline:none;min-height:38px;max-height:150px;font-family:inherit;line-height:1.4;}
#chatInput:focus{border-color:var(--vscode-focusBorder);}
#sendBtn{padding:7px 18px;font-size:13px;font-weight:500;border:none;border-radius:6px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);white-space:nowrap;height:38px;}
#sendBtn:disabled{opacity:0.4;cursor:default;}
#newChatBtn{padding:4px 10px;font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:4px;cursor:pointer;background:transparent;color:var(--vscode-foreground);}
#newChatBtn:hover{background:var(--vscode-list-hoverBackground);}
#status{display:none;padding:4px 12px;font-size:11px;color:var(--vscode-descriptionForeground);background:var(--vscode-inputValidation-infoBackground);flex-shrink:0;}

/* Messages */
.msg{padding:8px 12px;border-radius:6px;max-width:92%;line-height:1.5;word-break:break-word;}
.msg.user{background:var(--vscode-textBlockQuote-background,#e8e8e8);align-self:flex-end;}
.msg.assistant{align-self:flex-start;width:100%;max-width:100%;padding:0;}

/* Reasoning block */
.reasoning-block{margin:4px 0 8px 0;border:1px solid var(--vscode-panel-border);border-radius:6px;overflow:hidden;}
.reasoning-header{display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);user-select:none;background:var(--vscode-sideBar-background,#f3f3f3);}
.reasoning-header:hover{background:var(--vscode-list-hoverBackground);}
.reasoning-arrow{font-size:10px;transition:transform 0.2s;}
.reasoning-arrow.open{transform:rotate(90deg);}
.reasoning-content{padding:8px 10px;font-size:12px;line-height:1.6;color:var(--vscode-descriptionForeground);background:var(--vscode-sideBar-background,#f3f3f3);border-top:1px solid var(--vscode-panel-border);white-space:pre-wrap;max-height:300px;overflow-y:auto;}
.reasoning-dot{display:inline-block;width:4px;height:4px;border-radius:50%;background:var(--vscode-descriptionForeground);margin:0 2px;animation:pulse 1.2s infinite;}
.reasoning-dot:nth-child(2){animation-delay:0.2s;}
.reasoning-dot:nth-child(3){animation-delay:0.4s;}
@keyframes pulse{0%,100%{opacity:0.3;}50%{opacity:1;}}

/* Answer block */
.answer-block{padding:0 2px;}
.answer-block code{font-size:12px;padding:1px 4px;border-radius:3px;background:rgba(0,0,0,0.08);}
.answer-block pre{margin:6px 0;padding:10px;border-radius:6px;background:var(--vscode-textCodeBlock-background,#1e1e1e);overflow-x:auto;}
.answer-block pre code{padding:0;background:transparent;color:var(--vscode-editor-foreground,#d4d4d4);}
.stream-cursor{display:inline-block;width:7px;height:15px;background:var(--vscode-foreground);animation:blink 0.8s step-end infinite;vertical-align:text-bottom;border-radius:1px;margin-left:1px;}
@keyframes blink{50%{opacity:0;}}

/* Empty state */
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;color:var(--vscode-descriptionForeground);font-size:13px;padding:40px;text-align:center;gap:4px;}
.empty-state .greeting{font-size:15px;font-weight:500;}
.empty-state .hint{font-size:12px;opacity:0.7;}

/* History sidebar */
#layout{display:flex;flex:1;min-height:0;}
#sidebar{width:190px;flex-shrink:0;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background,var(--vscode-editor-background));display:flex;flex-direction:column;min-height:0;}
#sidebarHeader{padding:8px 12px;font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;}
#historyList{flex:1;overflow-y:auto;padding:4px;display:flex;flex-direction:column;gap:2px;}
.history-empty{padding:16px 12px;font-size:11px;color:var(--vscode-descriptionForeground);text-align:center;}
.history-item{display:flex;align-items:center;gap:4px;padding:6px 8px;border-radius:4px;cursor:pointer;user-select:none;}
.history-item:hover{background:var(--vscode-list-hoverBackground);}
.history-item.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);}
.history-item-info{flex:1;min-width:0;}
.history-item-title{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.history-item-meta{font-size:10px;opacity:0.7;margin-top:1px;}
.history-item-del{flex-shrink:0;width:18px;height:18px;line-height:16px;text-align:center;border:none;background:transparent;color:var(--vscode-descriptionForeground);border-radius:3px;cursor:pointer;font-size:14px;opacity:0;transition:opacity 0.1s;}
.history-item:hover .history-item-del{opacity:1;}
.history-item-del:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-errorForeground);}
#main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;}

/* Search box */
#searchBox{padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;}
#searchInput{width:100%;padding:5px 8px;font-size:12px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:4px;outline:none;box-sizing:border-box;}
#searchInput:focus{border-color:var(--vscode-focusBorder);}

/* Rename button */
.history-item-rename{flex-shrink:0;width:18px;height:18px;line-height:16px;text-align:center;border:none;background:transparent;color:var(--vscode-descriptionForeground);border-radius:3px;cursor:pointer;font-size:13px;opacity:0;transition:opacity 0.1s;}
.history-item:hover .history-item-rename{opacity:1;}
.history-item-rename:hover{background:var(--vscode-list-hoverBackground);}

/* Markdown rendering */
.md-body{font-size:13px;line-height:1.6;word-break:break-word;}
.md-body h1,.md-body h2,.md-body h3{margin:10px 0 6px;font-weight:600;}
.md-body h1{font-size:16px;}
.md-body h2{font-size:15px;}
.md-body h3{font-size:14px;}
.md-body p{margin:4px 0;}
.md-body ul,.md-body ol{margin:4px 0;padding-left:20px;}
.md-body li{margin:2px 0;}
.md-body blockquote{margin:6px 0;padding:2px 10px;border-left:3px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);}
.md-body hr{border:none;border-top:1px solid var(--vscode-panel-border);margin:8px 0;}
.md-body table{border-collapse:collapse;margin:6px 0;}
.md-body th,.md-body td{border:1px solid var(--vscode-panel-border);padding:4px 8px;font-size:12px;}
.md-body th{background:var(--vscode-sideBar-background,#f3f3f3);}
.md-body code{font-size:12px;padding:1px 4px;border-radius:3px;background:rgba(0,0,0,0.08);font-family:Consolas,'Courier New',monospace;}
.md-body pre{background:var(--vscode-textCodeBlock-background,#1e1e1e);padding:10px;border-radius:6px;overflow-x:auto;margin:6px 0;}
.md-body pre code{padding:0;background:transparent;color:var(--vscode-editor-foreground,#d4d4d4);}
.md-body a{color:var(--vscode-textLink-foreground);}
.tool-status{margin:4px 0;padding:6px 10px;border-radius:6px;font-size:12px;background:var(--vscode-inputValidation-infoBackground);display:flex;gap:8px;align-items:flex-start;}
.tool-status .tool-icon{flex-shrink:0;min-width:16px;text-align:center;}
.tool-status .tool-body{flex:1;min-width:0;}
.tool-status .tool-name{font-weight:600;font-family:Consolas,'Courier New',monospace;word-break:break-all;}
.tool-status .tool-detail{white-space:pre-wrap;margin-top:4px;font-size:11px;color:var(--vscode-descriptionForeground);display:none;max-height:300px;overflow:auto;}
.tool-status .tool-toggle{cursor:pointer;color:var(--vscode-textLink-foreground);font-size:11px;user-select:none;margin-left:6px;}
.tool-status.ok{background:rgba(46,160,67,0.15);}
.tool-status.err{background:rgba(218,54,51,0.15);}
.tool-spinner{display:inline-block;width:10px;height:10px;border:2px solid var(--vscode-descriptionForeground);border-top-color:transparent;border-radius:50%;animation:toolspin 0.8s linear infinite;vertical-align:middle;}
@keyframes toolspin{to{transform:rotate(360deg);}}

/* LaTeX display */
.latex-block{margin:6px 0;padding:8px 10px;border-left:3px solid var(--vscode-focusBorder);background:var(--vscode-sideBar-background,#f3f3f3);border-radius:0 6px 6px 0;font-size:13px;overflow-x:auto;}
.latex-inline{font-family:Consolas,'Courier New',monospace;font-size:12px;padding:1px 4px;border-radius:3px;background:rgba(0,0,0,0.08);}
</style>
</head>
<body>
<div id="layout">
<div id="sidebar">
<div id="sidebarHeader">${t('chatHistory')}</div>
<div id="searchBox"><input id="searchInput" type="text" placeholder="${t('chatSearchPlaceholder')}"></div>
<div id="historyList">
<div class="history-empty">${t('chatHistoryPlaceholder')}</div>
</div>
</div>
<div id="main">
<div id="header">
<h2>${t('panelChat')}</h2>
<label style="font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;color:var(--vscode-descriptionForeground);">
<input id="toggleThink" type="checkbox" checked style="width:auto;cursor:pointer;">
🤔 <span id="thinkingLabel">${t('chatThinking')}</span>
</label>
<button id="stopBtn" style="display:none;padding:4px 10px;font-size:11px;border:1px solid var(--vscode-panel-border);border-radius:4px;cursor:pointer;background:transparent;color:var(--vscode-foreground);">${t('chatStop')}</button>
<button id="newChatBtn">${t('chatNewChat')}</button>
</div>
<div id="status"></div>
<div id="messages">
<div class="empty-state">
<p class="greeting">${t('panelChat')}</p>
<p class="hint">${t('chatInputPlaceholder')}</p>
</div>
</div>
<div id="inputArea">
<div id="inputRow">
<textarea id="chatInput" placeholder="${t('chatInputPlaceholder')}" rows="1"></textarea>
<button id="sendBtn">${t('chatSend')}</button>
</div>
</div>
</div>
</div>

<script nonce="${nonce}">
(function(){
	var api = acquireVsCodeApi();
	var LOCALE = ${JSON.stringify({
		chatLoading: t('chatLoading'),
		chatNewChat: t('chatNewChat'),
		chatInputPlaceholder: t('chatInputPlaceholder'),
		chatThinking: t('chatThinking'),
		chatHistory: t('chatHistory'),
		chatHistoryPlaceholder: t('chatHistoryPlaceholder'),
		chatMsgCount: t('chatMsgCount'),
		chatSearchPlaceholder: t('chatSearchPlaceholder'),
		chatRename: t('chatRename'),
		chatEmptyResponse: t('chatEmptyResponse'),
		chatStop: t('chatStop'),
		chatStopped: t('chatStopped'),
		toolOutput: t('toolOutput'),
		toolRunning: t('toolRunning'),
		toolDone: t('toolDone'),
		toolFailed: t('toolFailed'),
		toolWaiting: t('toolWaiting'),
	})};

	var messagesEl = document.getElementById('messages');
	var inputEl = document.getElementById('chatInput');
	var sendBtn = document.getElementById('sendBtn');
	var newChatBtn = document.getElementById('newChatBtn');
	var stopBtn = document.getElementById('stopBtn');
	var statusEl = document.getElementById('status');
	var historyListEl = document.getElementById('historyList');
	var searchInputEl = document.getElementById('searchInput');
	var currentHistoryId = null;
	var searchQuery = '';

	// State for current assistant message being streamed
	var currentMsg = null;        // .msg.assistant wrapper div
	var currentReasoning = null;  // .reasoning-block inside currentMsg
	var currentReasoningContent = null; // .reasoning-content inside reasoning block
	var currentAnswer = null;     // .answer-block inside currentMsg
	var currentAnswerCursor = null;
	var streamingActive = false;
	var showThinking = true;

	document.getElementById('toggleThink').addEventListener('change', function(){
		showThinking = this.checked;
	});

	// Auto-resize input
	inputEl.addEventListener('input', function(){
		this.style.height = 'auto';
		this.style.height = Math.min(this.scrollHeight, 150) + 'px';
	});

	function setStreaming(on){
		streamingActive = on;
		sendBtn.disabled = on; inputEl.disabled = on;
		stopBtn.style.display = on ? '' : 'none';
	}

	function sendMessage(){
		var text = inputEl.value.trim();
		if(!text || sendBtn.disabled) return;
		inputEl.value = ''; inputEl.style.height = 'auto';
		addUserMessage(text);
		setStreaming(true);
		startAssistantMessage();
		api.postMessage({ type: 'chat', text: text });
	}

	stopBtn.addEventListener('click', function(){
		api.postMessage({ type: 'stopChat' });
	});

	sendBtn.addEventListener('click', sendMessage);
	inputEl.addEventListener('keydown', function(e){
		if(e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229){ e.preventDefault(); sendMessage(); }
	});

	newChatBtn.addEventListener('click', function(){
		api.postMessage({ type: 'newChat' });
		messagesEl.innerHTML = '<div class="empty-state"><p class="greeting">' + LOCALE.chatNewChat + '</p><p class="hint">' + LOCALE.chatInputPlaceholder + '</p></div>';
		currentMsg = null; currentReasoning = null; currentReasoningContent = null;
		currentAnswer = null; streamingActive = false;
		currentHistoryId = null;
	});

	if(searchInputEl){
		searchInputEl.addEventListener('input', function(){
			searchQuery = this.value.trim().toLowerCase();
			renderHistoryList(historyItems);
		});
	}

	// ========== Message event handlers ==========
	window.addEventListener('message', function(e){
		var d = e.data;
		if(d.type === 'chatReasoning'){
			if(showThinking) handleReasoning(d.text);
		} else if(d.type === 'chatToken'){
			handleToken(d.token);
		} else if(d.type === 'chatDone'){
			handleDone();
		} else if(d.type === 'chatError'){
			handleError(d.text);
		} else if(d.type === 'chatStatus'){
			statusEl.textContent = d.text; statusEl.style.display = '';
			setTimeout(function(){ statusEl.style.display = 'none'; }, 3000);
		} else if(d.type === 'historyList'){
			renderHistoryList(d.items || []);
		} else if(d.type === 'historyLoaded'){
			loadMessages(d.messages || []);
			currentHistoryId = d.id;
			renderHistoryList(getHistoryItems());
			messagesEl.scrollTop = messagesEl.scrollHeight;
		} else if(d.type === 'toolEvent'){
			onToolEvent(d.data);
		} else if(d.type === 'chatDiag'){
			statusEl.textContent = d.text; statusEl.style.display = '';
		}
	});

	var toolSeq = 0;
	var currentToolEl = null;

	function onToolEvent(d){
		removeEmptyState();
		if(d.type === 'start'){
			var el = document.createElement('div');
			el.className = 'tool-status';
			el.id = 'tool-' + (++toolSeq);
			el.innerHTML = '<span class="tool-icon"><span class="tool-spinner"></span></span><div class="tool-body"><div class="tool-name">' + esc(d.name) + '</div></div>';
			messagesEl.appendChild(el);
			currentToolEl = el;
		} else if(d.type === 'approval'){
			if(!currentToolEl){
				var el2 = document.createElement('div');
				el2.className = 'tool-status';
				el2.id = 'tool-' + (++toolSeq);
				el2.innerHTML = '<span class="tool-icon">⚠️</span><div class="tool-body"><div class="tool-name">' + esc(d.name) + '</div></div>';
				messagesEl.appendChild(el2);
				currentToolEl = el2;
			}
			var note = document.createElement('div');
			note.className = 'tool-detail';
			note.style.display = '';
			note.textContent = LOCALE.toolWaiting + ': ' + (d.summary || '');
			currentToolEl.querySelector('.tool-body').appendChild(note);
		} else if(d.type === 'result' && currentToolEl){
			currentToolEl.classList.add(d.ok ? 'ok' : 'err');
			var icon = currentToolEl.querySelector('.tool-icon');
			icon.textContent = d.ok ? '✓' : '✗';
			var nameEl = currentToolEl.querySelector('.tool-name');
			nameEl.textContent = d.name + (d.ok ? ' ' + LOCALE.toolDone : ' ' + LOCALE.toolFailed);
			var bodyEl = currentToolEl.querySelector('.tool-body');
			var detail = document.createElement('div');
			detail.className = 'tool-detail';
			detail.style.display = 'block';
			detail.textContent = d.content || '';
			bodyEl.appendChild(detail);
			var toggle = document.createElement('span');
			toggle.className = 'tool-toggle';
			toggle.textContent = LOCALE.toolOutput;
			toggle.onclick = function(){
				detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
			};
			bodyEl.appendChild(toggle);
		}
	}

	// ========== History sidebar ==========

	var historyItems = [];

	function getHistoryItems(){ return historyItems; }

	function renderHistoryList(items){
		historyItems = items || [];
		historyListEl.innerHTML = '';
		var filtered = historyItems;
		if(searchQuery){
			filtered = historyItems.filter(function(it){
				return (it.title || '').toLowerCase().indexOf(searchQuery) >= 0 ||
					(it.messages || []).some(function(m){ return m.content && m.content.toLowerCase().indexOf(searchQuery) >= 0; });
			});
		}
		if(!filtered.length){
			var empty = document.createElement('div');
			empty.className = 'history-empty';
			empty.textContent = searchQuery ? LOCALE.chatSearchNoResult : LOCALE.chatHistoryPlaceholder;
			historyListEl.appendChild(empty);
			return;
		}
		filtered.forEach(function(item){
			var row = document.createElement('div');
			row.className = 'history-item' + (currentHistoryId === item.id ? ' active' : '');
			row.title = item.title;

			var info = document.createElement('div');
			info.className = 'history-item-info';
			var titleEl = document.createElement('div');
			titleEl.className = 'history-item-title';
			titleEl.textContent = item.title || 'Chat';
			var metaEl = document.createElement('div');
			metaEl.className = 'history-item-meta';
			metaEl.textContent = LOCALE.chatMsgCount.replace('{0}', String((item.messages || []).length));
			info.appendChild(titleEl);
			info.appendChild(metaEl);

			var delBtn = document.createElement('button');
			delBtn.className = 'history-item-del';
			delBtn.textContent = '✕';
			delBtn.title = 'Delete';
			delBtn.addEventListener('click', function(ev){
				ev.stopPropagation();
				api.postMessage({ type: 'deleteHistory', id: item.id });
			});

			var renameBtn = document.createElement('button');
			renameBtn.className = 'history-item-rename';
			renameBtn.textContent = '✎';
			renameBtn.title = LOCALE.chatRename;
			renameBtn.addEventListener('click', function(ev){
				ev.stopPropagation();
				api.postMessage({ type: 'renameHistory', id: item.id, title: item.title || '' });
			});

			row.addEventListener('click', function(){
				if(streamingActive) return;
				api.postMessage({ type: 'loadHistory', id: item.id });
			});

			row.appendChild(info);
			row.appendChild(renameBtn);
			row.appendChild(delBtn);
			historyListEl.appendChild(row);
		});
	}

	function loadMessages(messages){
		currentMsg = null; currentReasoning = null; currentReasoningContent = null;
		currentAnswer = null; currentAnswerCursor = null; streamingActive = false;
		messagesEl.innerHTML = '';
		(messages || []).forEach(function(m){
			if(m.role === 'user'){
				var udiv = document.createElement('div');
				udiv.className = 'msg user';
				udiv.textContent = m.content;
				messagesEl.appendChild(udiv);
			} else if(m.role === 'assistant'){
				var adiv = document.createElement('div');
				adiv.className = 'msg assistant';
				var ablock = document.createElement('div');
				ablock.className = 'answer-block';
				if(m.content && m.content.trim()){
					ablock.innerHTML = renderMarkdown(m.content);
				} else {
					ablock.innerHTML = '<span style="color:var(--vscode-descriptionForeground);font-style:italic;">' + LOCALE.chatEmptyResponse + '</span>';
				}
				adiv.appendChild(ablock);
				messagesEl.appendChild(adiv);
			}
		});
	}

	// Request history list on load
	api.postMessage({ type: 'requestHistoryList' });

	function handleReasoning(text){
		if(!currentReasoningContent){
			if(!currentReasoning){
				// Create reasoning block if not exists
				currentReasoning = document.createElement('div');
				currentReasoning.className = 'reasoning-block';

				var header = document.createElement('div');
				header.className = 'reasoning-header';
				header.onclick = function(){
					var block = this.closest('.reasoning-block');
					var content = block.querySelector('.reasoning-content');
					var arrow = this.querySelector('.reasoning-arrow');
					if(content){
						var isHidden = content.style.display === 'none';
						content.style.display = isHidden ? '' : 'none';
						if(arrow) arrow.classList.toggle('open');
					}
				};

				var arrow = document.createElement('span');
				arrow.className = 'reasoning-arrow open';
				arrow.textContent = '\u25B6';
				header.appendChild(arrow);

				var label = document.createElement('span');
				label.textContent = '\uD83E\uDD14 ' + LOCALE.chatThinking;
				header.appendChild(label);

				var dots = document.createElement('span');
				dots.innerHTML = '<span class="reasoning-dot"></span><span class="reasoning-dot"></span><span class="reasoning-dot"></span>';
				dots.style.marginLeft = '4px';
				header.appendChild(dots);

				currentReasoning.appendChild(header);

				currentReasoningContent = document.createElement('div');
				currentReasoningContent.className = 'reasoning-content';
				currentReasoningContent.textContent = '';
				currentReasoning.appendChild(currentReasoningContent);
				if(currentMsg) currentMsg.appendChild(currentReasoning);
			}
		}
		if(currentReasoningContent){
			currentReasoningContent.insertAdjacentText('beforeend', text);
			if(currentReasoningContent.scrollHeight - currentReasoningContent.scrollTop - currentReasoningContent.clientHeight < 40) currentReasoningContent.scrollTop = currentReasoningContent.scrollHeight;
		}
	}

	function handleToken(token){
		// Reasoning is done, first answer token - finalize reasoning
		if(currentReasoningContent){
			var arrow = currentReasoning.querySelector('.reasoning-arrow');
			if(arrow) arrow.classList.add('open');
			var dots = currentReasoning.querySelector('.reasoning-dot');
			if(dots && dots.parentNode) dots.parentNode.style.display = 'none';
			if(currentReasoning) currentReasoning.style.opacity = '0.85';
		}
		if(!currentAnswer){
			createAnswerBlock();
		}
		if(currentAnswer){
			currentAnswerRaw = (currentAnswerRaw || '') + token;
			currentAnswer.innerHTML = renderMarkdown(currentAnswerRaw);
			var cursor = document.createElement('span');
			cursor.className = 'stream-cursor';
			currentAnswer.appendChild(cursor);
			currentAnswerCursor = cursor;
			if(messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80) messagesEl.scrollTop = messagesEl.scrollHeight;
		}
	}

	function handleDone(){
		if(currentAnswer && currentAnswerCursor){
			currentAnswerCursor.remove(); currentAnswerCursor = null;
		}
		if(currentAnswer && !currentAnswer.textContent.trim()){
			currentAnswer.innerHTML = '<span style="color:var(--vscode-descriptionForeground);font-style:italic;">' + LOCALE.chatEmptyResponse + '</span>';
		}
		currentAnswerRaw = null;
		setStreaming(false);
		inputEl.focus();
	}

	function handleError(text){
		if(currentReasoning || currentAnswer || currentMsg){
			// Clean up streaming state
			if(currentAnswer && currentAnswerCursor){
				currentAnswerCursor.remove(); currentAnswerCursor = null;
			}
			// Add error to current answer if exists
			if(currentAnswer && !currentAnswer.textContent.trim()){
				currentAnswer.innerHTML = '<span style="color:var(--vscode-errorForeground);">\u2717 ' + esc(text) + '</span>';
			} else {
				addErrorMessage('\u2717 ' + text);
			}
		} else {
			addErrorMessage('\u2717 ' + text);
		}
		setStreaming(false);
	}

	// ========== Markdown + LaTeX rendering ==========

	function renderMarkdown(md){
		var h = '';
		var lines = String(md||'').split('\\n');
		var inCode = false, codeBuf = [], codeLang = '';
		var listStack = [];
		var paraBuf = [];

		function flushPara(){
			if(paraBuf.length){
				var txt = escHtml(paraBuf.join(' '));
				txt = inline(txt);
				h += '<p>' + txt + '</p>\\n';
				paraBuf = [];
			}
		}
		function closeLists(){
			while(listStack.length){
				h += '</' + listStack.pop() + '>\\n';
			}
		}
		function inline(txt){
			txt = txt.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
			txt = txt.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
			txt = txt.replace(/__([^_]+)__/g, '<strong>$1</strong>');
			txt = txt.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
			txt = txt.replace(/(^|[^_])_([^_\\n]+)_/g, '$1<em>$2</em>');
			txt = txt.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2">$1</a>');
			txt = txt.replace(/\\$([^$\\n]+?)\\$\\$/g, function(m, inner){
				return '<span class="latex-inline">$' + escHtml(inner) + '$</span>';
			});
			return txt;
		}

		for(var i=0;i<lines.length;i++){
			var line = lines[i];
			var trimmed = line.trim();

			var fence = /^\`\`\`(\\w*)\\s*$/.exec(trimmed);
			if(fence){
				if(!inCode){
					flushPara(); closeLists();
					inCode = true; codeLang = fence[1]; codeBuf = [];
				} else {
					inCode = false;
					h += '<pre><code' + (codeLang ? ' class="lang-' + escHtml(codeLang) + '"' : '') + '>' + escHtml(codeBuf.join('\\n')) + '</code></pre>\\n';
					codeLang = ''; codeBuf = [];
				}
				continue;
			}
			if(inCode){ codeBuf.push(line); continue; }

			var blk = /^\\$\\$([\\s\\S]*)\\$\\$$/.exec(line);
			if(blk){
				flushPara(); closeLists();
				h += '<div class="latex-block">\\$\\$' + escHtml(blk[1]) + '\\$\\$</div>\\n';
				continue;
			}
			if(/^\\$\\$/.test(trimmed)){
				flushPara(); closeLists();
				var ltx = [trimmed.replace(/^\\$\\$/, '')];
				var j = i+1;
				var closed = /\\/\\$\\$$/.test(trimmed);
				while(j < lines.length && !closed){
					var l2 = lines[j].trim();
					if(/\\$\\$$/.test(l2)){ ltx.push(l2.replace(/\\$\\$$/,'')); closed = true; }
					else ltx.push(lines[j]);
					j++;
				}
				h += '<div class="latex-block">\\$\\$' + escHtml(ltx.join('\\n')) + '\\$\\$</div>\\n';
				i = j-1;
				continue;
			}

			if(trimmed === ''){ flushPara(); continue; }
			if(/^---+\\s*$/.test(trimmed) || /^\\*\\*\\*+\\s*$/.test(trimmed)){
				flushPara(); closeLists();
				h += '<hr>\\n'; continue;
			}
			var m;
			if(m = /^#{1,6}\\s+(.*)$/.exec(trimmed)){
				flushPara(); closeLists();
				var lvl = m[0].indexOf(' ');
				h += '<h' + lvl + '>' + inline(escHtml(m[1])) + '</h' + lvl + '>\\n';
				continue;
			}
			if(m = /^>\\s?(.*)$/.exec(trimmed)){
				flushPara();
				h += '<blockquote>' + inline(escHtml(m[1])) + '</blockquote>\\n';
				continue;
			}
			var li;
			if(li = /^[-*]\\s+(.*)$/.exec(trimmed)){
				flushPara();
				if(listStack[listStack.length-1] !== 'ul'){ closeLists(); h += '<ul>\\n'; listStack.push('ul'); }
				h += '<li>' + inline(escHtml(li[1])) + '</li>\\n';
				continue;
			}
			if(m = /^(\\d+)\\.\\s+(.*)$/.exec(trimmed)){
				flushPara();
				if(listStack[listStack.length-1] !== 'ol'){ closeLists(); h += '<ol>\\n'; listStack.push('ol'); }
				h += '<li>' + inline(escHtml(m[2])) + '</li>\\n';
				continue;
			}
			if(m = /^\\|(.+)\\|$/.exec(trimmed) && trimmed.split('|').length-2 >= 2){
				flushPara();
				var cells = m[1].split('|').map(function(c){ return c.trim(); });
				if(listStack.length){ closeLists(); }
				if(!h.match(/<table>/)){
					h += '<table>\\n<thead><tr>' + cells.map(function(c){ return '<th>' + inline(escHtml(c)) + '</th>'; }).join('') + '</tr></thead>\\n<tbody>\\n';
				} else {
					h += '<tr>' + cells.map(function(c){ return '<td>' + inline(escHtml(c)) + '</td>'; }).join('') + '</tr>\\n';
				}
				continue;
			}
			paraBuf.push(trimmed);
		}
		if(inCode){
			h += '<pre><code>' + escHtml(codeBuf.join('\\n')) + '</code></pre>\\n';
		}
		flushPara();
		closeLists();
		return '<div class="md-body">' + h + '</div>';
	}

	function setAnswerHtml(html){
		currentAnswer.innerHTML = html;
	}

	// ========== DOM builders ==========

	function addUserMessage(text){
		removeEmptyState();
		var div = document.createElement('div');
		div.className = 'msg user';
		div.textContent = text;
		messagesEl.appendChild(div);
		if(messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80) messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function startAssistantMessage(){
		removeEmptyState();
		currentMsg = document.createElement('div');
		currentMsg.className = 'msg assistant';
		currentReasoning = null;
		currentReasoningContent = null;
		currentAnswer = null;
		currentAnswerCursor = null;
		currentAnswerRaw = null;
		streamingActive = true;
		messagesEl.appendChild(currentMsg);
		if(messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80) messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function createAnswerBlock(){
		currentAnswer = document.createElement('div');
		currentAnswer.className = 'answer-block';
		if(currentMsg) currentMsg.appendChild(currentAnswer);
	}

	function addErrorMessage(text){
		removeEmptyState();
		var div = document.createElement('div');
		div.className = 'msg assistant';
		div.innerHTML = '<div class="answer-block" style="color:var(--vscode-errorForeground);">' + esc(text) + '</div>';
		messagesEl.appendChild(div);
		if(messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80) messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function removeEmptyState(){
		var empty = messagesEl.querySelector('.empty-state');
		if(empty) empty.remove();
	}

	function esc(s){
		if(typeof s !== 'string') return '';
		return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
	}
	var escHtml = esc;

	// Focus input on load
	setTimeout(function(){ inputEl.focus(); }, 100);
})();
</script>
</body>
</html>`;
}

// ── SCM 自动补全：由标题栏按钮触发（cmg-vscode.autocomplete） ───────

// Chat history persisted to globalState
interface ChatHistoryEntry {
	id: string;
	title: string;
	messages: { role: string; content: string }[];
	createdAt: number;
}
const CHAT_HISTORY_KEY_BASE = 'hisccs.chatHistories';
const CHAT_HISTORY_MAX = 50;

function workspaceHashKey(): string {
	try {
		const repo = getMainRepository();
		return `${CHAT_HISTORY_KEY_BASE}.${hashWorkspacePath(repo.rootUri.fsPath)}`;
	} catch {
		return `${CHAT_HISTORY_KEY_BASE}.global`;
	}
}

function loadChatHistories(context: vscode.ExtensionContext): ChatHistoryEntry[] {
	try {
		return context.globalState.get<ChatHistoryEntry[]>(workspaceHashKey(), []);
	} catch { return []; }
}

function saveChatHistories(context: vscode.ExtensionContext, list: ChatHistoryEntry[]) {
	const trimmed = list.slice(0, CHAT_HISTORY_MAX);
	context.globalState.update(workspaceHashKey(), trimmed);
}

// 打开某个提交中单个文件的 diff（提交 vs 其父提交）
async function openCommitFileDiff(hash: string, path: string) {
	const repo = getMainRepository();
	const commit = await repo.getCommit(hash);
	const parent = commit.parents.length > 0 ? commit.parents[0] : undefined;

	const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
	const gitApi = gitExt?.exports?.getAPI(1);
	if (!gitApi) {
		throw new Error('Git extension not available');
	}

	const fileUri = vscode.Uri.joinPath(repo.rootUri, path);
	const commitUri = gitApi.toGitUri(fileUri, hash);
	if (parent) {
		const parentUri = gitApi.toGitUri(fileUri, parent);
		const title = `${path} (${parent.substring(0, 7)} → ${hash.substring(0, 7)})`;
		await vscode.commands.executeCommand('vscode.diff', parentUri, commitUri, title);
	} else {
		// 根提交：无父提交，直接打开该文件在本次提交中的内容
		await vscode.commands.executeCommand('vscode.open', commitUri);
	}
}

export function activate(context: vscode.ExtensionContext) {
	console.log('[HisCCS] activate');

	const provider = new SettingsViewProvider(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SettingsViewProvider.viewType, provider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('cmg-vscode.selectCommitType', async () => {
			let repo;
			try {
				repo = getMainRepository();
			} catch {
				vscode.window.showInformationMessage(t('errNoRepository'));
				return;
			}
			const items = COMMIT_TYPES.map(ct => ({
				label: ct.insertText,
				description: ct.description,
			}));
			const pick = await vscode.window.showQuickPick(items, {
				placeHolder: t('selectCommitTypePlaceholder'),
				matchOnDescription: true,
			});
			if (!pick) return; // ESC → 不做任何修改
			const prefix = pick.label;
			const existing = repo.inputBox.value || '';
			repo.inputBox.value = existing ? prefix + existing : prefix;
		}),
		vscode.commands.registerCommand('cmg-vscode.autocomplete', async () => {
			let repo;
			try {
				repo = getMainRepository();
			} catch {
				vscode.window.showInformationMessage(t('errNoRepository'));
				return;
			}
			const current = repo.inputBox.value || '';
			if (!current.trim()) {
				vscode.window.showInformationMessage(t('autocompleteEmptyHint'));
				return;
			}
			if (scmAiBusy) return;
			scmAiBusy = true;
			await generateAndPick(undefined, current).finally(() => { scmAiBusy = false; });
		}),
		vscode.commands.registerCommand('cmg-vscode.autofill', async () => {
			await generateAndPick();
		}),
		vscode.commands.registerCommand('cmg-vscode.openSettings', () => {
			vscode.commands.executeCommand('workbench.view.extension.hisccs');
		}),
		vscode.commands.registerCommand('cmg-vscode.viewCommitHistory', () => {
			const panel = vscode.window.createWebviewPanel(
				'hisccs.commitHistory',
				t('panelCommitHistory'),
				vscode.ViewColumn.One,
				{ enableScripts: true, retainContextWhenHidden: true }
			);
			panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'logo.png');
			panel.webview.html = buildHistoryHtml(getNonce(), panel.webview);
			let allCommits: any[] = [];
			panel.webview.onDidReceiveMessage(async (msg) => {
				if (msg.type === 'ready') {
					try {
						const commits = await getCommitHistory(200);
						allCommits = commits.map(c => ({
							hash: c.hash,
							shortHash: c.hash.substring(0, 7),
							message: c.message.split('\n')[0],
							authorName: c.authorName || '',
							authorDate: c.authorDate ? c.authorDate.toISOString() : '',
						}));
						panel.webview.postMessage({ type: 'commits', commits: allCommits });
					} catch (e) {
						panel.webview.postMessage({ type: 'error', text: t('errNoRepository') });
					}
				} else if (msg.type === 'search') {
					try {
						const q = msg.query || '';
						if (!q) {
							panel.webview.postMessage({ type: 'searchResults', commits: allCommits.slice(0, 30) });
							return;
						}
						const results = searchCommitsBM25(allCommits, q);
						panel.webview.postMessage({ type: 'searchResults', commits: results.slice(0, 30).map(r => r.commit) });
					} catch (e) {
						panel.webview.postMessage({ type: 'searchResults', commits: allCommits.slice(0, 30) });
					}
				} else if (msg.type === 'fetchChanges') {
					try {
						const changes = await getCommitChanges(msg.hash);
						panel.webview.postMessage({ type: 'changes', hash: msg.hash, changes });
					} catch (e) {
						panel.webview.postMessage({ type: 'error', text: String(e) });
					}
				} else if (msg.type === 'openFile') {
					try {
						openCommitFileDiff(msg.hash, msg.path);
					} catch (e) {
						vscode.window.showErrorMessage(String(e));
					}
				}
			});
		}),
		vscode.commands.registerCommand('cmg-vscode.openChat', () => {
			const panel = vscode.window.createWebviewPanel(
				'hisccs.chat',
				t('panelChat'),
				vscode.ViewColumn.One,
				{ enableScripts: true, retainContextWhenHidden: true }
			);
			panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'logo.png');
			const nonce = getNonce();
			panel.webview.html = buildChatHtml(nonce, panel.webview);

			const extCtx = context;
			let chatHistory: { role: string; content: string }[] = [];
			let currentHistoryId: string | undefined = undefined;
			let currentAbort: AbortController | null = null;

			const persistHistory = () => {
				try {
					const list = loadChatHistories(extCtx);
					if (currentHistoryId) {
						const idx = list.findIndex(h => h.id === currentHistoryId);
						const firstUser = chatHistory.find(m => m.role === 'user')?.content?.split('\n')[0]?.slice(0, 30) || 'Chat';
						let repoName = '';
						try { repoName = getMainRepository().rootUri.fsPath.split(/[\\/]/).pop() || ''; } catch {}
						const title = repoName ? `${repoName}: ${firstUser}` : firstUser;
						if (idx >= 0) {
							list[idx].title = title;
							list[idx].messages = chatHistory.slice();
							list[idx].createdAt = Date.now();
						} else {
							list.unshift({ id: currentHistoryId, title, messages: chatHistory.slice(), createdAt: Date.now() });
						}
					} else if (chatHistory.length > 0) {
						currentHistoryId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
						const firstUser = chatHistory.find(m => m.role === 'user')?.content?.split('\n')[0]?.slice(0, 30) || 'Chat';
						let repoName = '';
						try { repoName = getMainRepository().rootUri.fsPath.split(/[\\/]/).pop() || ''; } catch {}
						const title = repoName ? `${repoName}: ${firstUser}` : firstUser;
						list.unshift({ id: currentHistoryId, title, messages: chatHistory.slice(), createdAt: Date.now() });
					}
					saveChatHistories(extCtx, list);
					sendHistoryList();
				} catch (err) {
					console.error('[HisCCS] persistHistory error:', err);
				}
			};

			const sendHistoryList = () => {
				const list = loadChatHistories(extCtx);
				panel.webview.postMessage({ type: 'historyList', items: list });
			};

			panel.webview.onDidReceiveMessage(async (msg) => {
			if (msg.type === 'stopChat') {
					currentAbort?.abort();
					return;
				}
				if (msg.type === 'requestHistoryList') {
					sendHistoryList();
					return;
				}
				if (msg.type === 'loadHistory') {
					const list = loadChatHistories(extCtx);
					const entry = list.find(h => h.id === msg.id);
					if (entry) {
						currentHistoryId = entry.id;
						chatHistory = entry.messages.map(m => ({ role: m.role, content: m.content }));
						panel.webview.postMessage({ type: 'historyLoaded', id: entry.id, messages: entry.messages });
					} else {
						panel.webview.postMessage({ type: 'chatError', text: t('chatHistoryLoadError') });
					}
					return;
				}
				if (msg.type === 'renameHistory') {
					const newTitle = await vscode.window.showInputBox({
						placeHolder: msg.title || '',
						prompt: t('chatRenamePrompt'),
						value: msg.title || '',
					});
					if (!newTitle || !newTitle.trim()) return;
					const list = loadChatHistories(extCtx);
					const entry = list.find(h => h.id === msg.id);
					if (entry) {
						entry.title = newTitle.trim();
						saveChatHistories(extCtx, list);
						sendHistoryList();
					}
					return;
				}
				if (msg.type === 'deleteHistory') {
					const list = loadChatHistories(extCtx);
					const filtered = list.filter(h => h.id !== msg.id);
					saveChatHistories(extCtx, filtered);
					if (currentHistoryId === msg.id) {
						currentHistoryId = undefined;
						chatHistory = [];
					}
					sendHistoryList();
					return;
				}
				if (msg.type === 'newChat') {
					chatHistory.length = 0;
					currentHistoryId = undefined;
					sendHistoryList();
					return;
				}
				if (msg.type === 'chat') {
					let fullResponse = '';
					const abort = new AbortController();
					currentAbort = abort;
					_activeChatAbort = abort;
					try {
						const cfg = vscode.workspace.getConfiguration('cmg');
						const apiKey = cfg.apiKey || msg.apiKey || '';
						if (!apiKey) {
							panel.webview.postMessage({ type: 'chatError', text: t('chatConfigError') });
							return;
						}
						const provider: string = cfg.provider || 'deepseek';
						const baseUrl = cfg.baseUrl || PROVIDER_BASE_URLS[provider] || '';
						const modelName = cfg.modelName || '';
						const defaultModels: Record<string, string> = {
							deepseek: 'deepseek-chat',
							qwen: 'qwen-plus',
							openai: 'gpt-4o-mini',
						};
						const providerCfg = {
							baseUrl: baseUrl,
							model: modelName || defaultModels[provider] || 'deepseek-chat',
							apiKey,
						};
						panel.webview.postMessage({ type: 'chatStatus', text: t('chatContextReady') });
						const chatCtx = await buildChatContext();
						const systemMsg = 'You are an AI programming assistant in VS Code.\n\nRULES:\n1. RESPOND FAST - keep answers short and direct.\n2. Keep reasoning CONCISE - one or two sentences max.\n3. Answer immediately after brief reasoning.\n4. Use markdown for code.\n5. For simple questions, answer in 1-3 sentences.\n\nCurrent project context:\n' + chatCtx;
						chatHistory.push({ role: 'user', content: msg.text });
						const messages: ChatMessage[] = [
							{ role: 'system', content: systemMsg },
							...chatHistory.filter(m => m.role !== 'assistant' || (m.content && m.content.trim())) as ChatMessage[],
						];
						const temperature = cfg.temperature ?? 0.7;
						// 聊天不约束 token 消耗：不发送 max_tokens，交由服务端默认上限
						const maxTokens: number | undefined = undefined;
						const workspaceRoot = (() => {
							try { return getMainRepository().rootUri.fsPath; } catch { return process.cwd(); }
						})();
						const nativeTools = cfg.nativeTools !== false;
						const tools = listTools();
						fullResponse = await runChat({
							messages,
							providerCfg,
							temperature,
							maxTokens,
							tools,
							nativeTools,
							signal: abort.signal,
							workspaceRoot,
							confirm: async (summary, detail) => {
								const choice = await vscode.window.showWarningMessage(
									summary,
									{ detail, modal: true },
									t('confirmYes'),
									t('confirmNo'),
								);
								return choice === t('confirmYes');
							},
							onToken: (token) => panel.webview.postMessage({ type: 'chatToken', token }),
							onReasoning: (reasoning) => panel.webview.postMessage({ type: 'chatReasoning', text: reasoning }),
							onToolEvent: (ev: ToolEvent) => panel.webview.postMessage({ type: 'toolEvent', data: ev }),
						});
						chatHistory.push({ role: 'assistant', content: fullResponse });
						panel.webview.postMessage({ type: 'chatDone' });
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						if (chatHistory[chatHistory.length - 1]?.role !== 'assistant') {
							chatHistory.push({ role: 'assistant', content: '' });
						}
						const isAbort = err instanceof Error && (err.name === 'AbortError' || /Stopped by user/i.test(err.message));
						if (isAbort) {
							panel.webview.postMessage({ type: 'chatError', text: t('chatStopped') });
						} else {
							panel.webview.postMessage({ type: 'chatError', text: t('chatError', errMsg) });
						}
						console.error('[HisCCS] Chat error:', err);
					} finally {
						currentAbort = null;
						_activeChatAbort = null;
						persistHistory();
					}
					return;
				}
			});
		}),		vscode.languages.registerCompletionItemProvider(documentFilters, new CommitCompletionItemProvider(), ...'abcdefghijklmnopqrstuvwxyz'),
		vscode.languages.registerInlineCompletionItemProvider(documentFilters, new InlineCommitCompletionItemProvider()),
	);
}

export function deactivate() {
	_activeChatAbort?.abort();
	_activeChatAbort = null;
}
