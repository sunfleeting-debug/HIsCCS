<div align="center">
  <img src=".github/assets/icon.png" width="108" alt="HisCCS" />
  <h1>HisCCS</h1>
  <p><b>让你的 AI 写出「像你写的」commit message</b><br /><sub>VSCode / JetBrains 双端插件 · 读 diff 一键生成 Conventional Commits</sub></p>
  <p>
    <img src="https://img.shields.io/badge/VSCode-%E6%8F%92%E4%BB%B6-007ACC" alt="VSCode 插件">
    <img src="https://img.shields.io/badge/JetBrains-IDEA%20%2F%20PyCharm-000000" alt="JetBrains 插件">
    <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6" alt="TypeScript">
    <img src="https://img.shields.io/badge/Kotlin-1.9-7F52FF" alt="Kotlin">
    <img src="https://img.shields.io/badge/License-MIT-97CA00" alt="License: MIT">
  </p>
  <p>
    <b>简体中文</b> ·
    <a href="README.en.md">English</a>
  </p>
</div>

还在手写 commit message？让 HisCCS 把提交写成艺术。

HisCCS 是一个 AI 驱动的 Git 提交信息生成插件，支持 **VSCode** 与 **JetBrains**（IDEA / PyCharm）。它读取你的 diff，一键生成符合 Conventional Commits 规范的提交信息：内置类型选择器，规范不再靠自觉；写到一半的句子，AI 帮你补完。

它的独特之处：生成前先用 **BM25** 检索你的**历史提交**作为风格参考 —— AI 生成的不是通用模板，而是"像你写的"提交信息。多模型支持（DeepSeek / 通义千问 / OpenAI），API 自由可控。

## 一览

| | |
| --- | --- |
| **形态** | 编辑器插件（双端同源实现） |
| **平台** | VSCode `^1.88.0` · JetBrains `241`–`251.*`（IDEA Community 2024.1） |
| **模型** | DeepSeek / 通义千问 / OpenAI，以及任何 **OpenAI 兼容**接口 |
| **核心机制** | diff → BM25 检索历史提交 → 提示词组装 → 生成候选 |
| **安装** | 两端插件市场搜 **HisCCS**，或本地构建 `.vsix` / `.zip` |
| **许可** | MIT |

---

## ✨ 特性

- **一键生成**：读当前暂存的 diff，生成多条候选提交信息，挑一条即可。
- **类型选择器**：`feat` / `fix` / `docs` / `refactor` … 内置选择器，Conventional Commits 不再靠自觉。
- **AI 补全**：写到一半的提交信息，AI 接着补完。
- **提交历史面板**：回看历史提交，同时作为风格检索的语料。
- **AI Chat 侧栏**：在编辑器里直接和模型对话，不必切窗口。
- **Agent 工具**：内置文件与 Git 工具（读文件、看 diff 等），由 `AgentSecurity` 约束调用边界，模型不会乱动你的工作区。
- **多模型可换**：只要接口是 OpenAI 兼容的，`apiEndpoint` 填上就能用。

---

## 📦 安装

**从市场安装（推荐）**

- **VSCode**：插件市场搜索 `HisCCS`
- **JetBrains**（IDEA / PyCharm）：插件市场搜索 `HisCCS`

**从源码构建**

```bash
# VSCode
cd vscode
npm install
npm run package          # 生成 .vsix，随后在编辑器里「从 VSIX 安装」
```

```bash
# JetBrains
cd jetbrains
./gradlew buildPlugin    # 产物在 build/distributions/*.zip
# 安装：Settings → Plugins → ⚙ → Install Plugin from Disk…
```

---

## 🚀 使用

1. 在插件设置里填入 **API Key**，并选好 `apiEndpoint`（DeepSeek / 通义千问 / OpenAI 等）。
2. 修改代码并**暂存**变更。
3. 在提交框点击按钮，或用命令面板 / 快捷键触发生成：
   - `HisCCS: Generate Commit Message` —— 生成候选
   - `HisCCS: Select Commit Type` —— 选类型
   - `HisCCS: Autocomplete Commit Message` —— 补全半句
   - `HisCCS: View Commit History` / `Open AI Chat` / `Settings`
4. 从候选里选一条，或输入前缀让 AI 补全。

---

## ⚙️ 配置

| 配置项 | 说明 |
| --- | --- |
| `cmg.apiKey` | AI 服务的 API Key |
| `cmg.apiEndpoint` | 接口地址（OpenAI 兼容即可） |
| `cmg.AccordingHistoryOrNot` | 是否用历史提交做风格参考（BM25 检索） |
| `cmg.temperature` | 采样温度 |
| `cmg.max_tokens` | 单次生成的最大 token 数 |

---

## 📁 目录结构

| 目录 | 说明 |
| --- | --- |
| [`vscode/`](vscode/) | VSCode 插件（TypeScript）· 入口 `src/extension.ts`，Agent 实现在 `src/agent/` |
| [`jetbrains/`](jetbrains/) | JetBrains 插件（Kotlin）· 包名 `com.bluecome.cmg`，检索在 `services/RetrievalService.kt` |

两端的命令 ID 都是 `cmg.*` 前缀（历史命名沿革），产品名统一为 **HisCCS**。

---

## 🛠 开发

```bash
# VSCode
cd vscode
npm install
npm run compile      # 或 npm run watch
npm run lint         # ESLint
npm test             # @vscode/test-electron
```

```bash
# JetBrains
cd jetbrains
./gradlew buildPlugin        # 构建
./gradlew runIde             # 起一个带插件的 IDE 实例
./gradlew verifyPlugin       # 用 IntelliJ Plugin Verifier 检查兼容性
```

---

## 🤝 致谢

- 基于 [VSCode Extension API](https://code.visualstudio.com/api) 与 [IntelliJ Platform Gradle Plugin](https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html) 构建。
- 模型能力由 DeepSeek / 通义千问 / OpenAI 等提供，Key 与费用由使用者自行承担。

## 📄 许可

[MIT](vscode/LICENSE) © 2026 BlueCome
