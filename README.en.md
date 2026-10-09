<div align="center">
  <img src=".github/assets/icon.png" width="108" alt="HisCCS" />
  <h1>HisCCS</h1>
  <p><b>Commit messages that read like you wrote them</b><br /><sub>A VSCode / JetBrains plugin that turns your diff into a Conventional Commit</sub></p>
  <p>
    <img src="https://img.shields.io/badge/VSCode-extension-007ACC" alt="VSCode extension">
    <img src="https://img.shields.io/badge/JetBrains-IDEA%20%2F%20PyCharm-000000" alt="JetBrains plugin">
    <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6" alt="TypeScript">
    <img src="https://img.shields.io/badge/Kotlin-1.9-7F52FF" alt="Kotlin">
    <img src="https://img.shields.io/badge/License-MIT-97CA00" alt="License: MIT">
  </p>
  <p>
    <a href="README.md">简体中文</a> ·
    <b>English</b>
  </p>
</div>

Still writing commit messages by hand? Let HisCCS make them an art form.

HisCCS is an AI-powered Git commit message generator for **VSCode** and **JetBrains** (IDEA / PyCharm). It reads your diff and generates a Conventional Commits–compliant message in one click: a built-in type selector so the convention stops relying on discipline, and AI completion for the half-written sentence.

What makes it different: before generating, it uses **BM25** to retrieve your **own past commits** as a style reference — so the output isn't a generic template, it's a message that sounds like you. Multiple providers supported (DeepSeek / Qwen / OpenAI), with your own API key.

## At a glance

| | |
| --- | --- |
| **Shape** | Editor plugin (two platforms, same design) |
| **Platforms** | VSCode `^1.88.0` · JetBrains `241`–`251.*` (IDEA Community 2024.1) |
| **Models** | DeepSeek / Qwen / OpenAI, plus any **OpenAI-compatible** endpoint |
| **Core loop** | diff → BM25 over past commits → prompt assembly → candidates |
| **Install** | Search **HisCCS** in either marketplace, or build `.vsix` / `.zip` locally |
| **License** | MIT |

---

## ✨ Features

- **One-click generation** — reads the staged diff and produces several candidate messages; pick one.
- **Type selector** — `feat` / `fix` / `docs` / `refactor` … built in, so Conventional Commits isn't left to willpower.
- **AI autocomplete** — finish a half-written commit message.
- **Commit history panel** — browse past commits, which double as the style-retrieval corpus.
- **AI Chat sidebar** — talk to the model without leaving the editor.
- **Agent tools** — built-in file and Git tools (read files, inspect diffs, …) with `AgentSecurity` constraining what the model may touch, so it can't rummage through your workspace.
- **Provider-agnostic** — if the endpoint is OpenAI-compatible, set `apiEndpoint` and go.

---

## 📦 Installation

**From the marketplace (recommended)**

- **VSCode**: search for `HisCCS` in the extensions marketplace
- **JetBrains** (IDEA / PyCharm): search for `HisCCS` in the plugins marketplace

**From source**

```bash
# VSCode
cd vscode
npm install
npm run package          # produces a .vsix to install via "Install from VSIX…"
```

```bash
# JetBrains
cd jetbrains
./gradlew buildPlugin    # output in build/distributions/*.zip
# Install: Settings → Plugins → ⚙ → Install Plugin from Disk…
```

---

## 🚀 Usage

1. Open the plugin settings, enter your **API key** and choose an `apiEndpoint` (DeepSeek / Qwen / OpenAI, …).
2. Make your changes and **stage** them.
3. Trigger generation from the commit box, the command palette or a keybinding:
   - `HisCCS: Generate Commit Message` — produce candidates
   - `HisCCS: Select Commit Type` — pick a type
   - `HisCCS: Autocomplete Commit Message` — complete a partial message
   - `HisCCS: View Commit History` / `Open AI Chat` / `Settings`
4. Choose a candidate, or type a prefix and let the model finish it.

---

## ⚙️ Settings

| Setting | Description |
| --- | --- |
| `cmg.apiKey` | API key for your model provider |
| `cmg.apiEndpoint` | Endpoint URL (any OpenAI-compatible API) |
| `cmg.AccordingHistoryOrNot` | Whether to use past commits as a style reference (BM25 retrieval) |
| `cmg.temperature` | Sampling temperature |
| `cmg.max_tokens` | Maximum tokens per generation |

---

## 📁 Repository layout

| Directory | Description |
| --- | --- |
| [`vscode/`](vscode/) | VSCode extension (TypeScript) · entry `src/extension.ts`, agent code in `src/agent/` |
| [`jetbrains/`](jetbrains/) | JetBrains plugin (Kotlin) · package `com.bluecome.cmg`, retrieval in `services/RetrievalService.kt` |

Command IDs on both sides keep the historical `cmg.*` prefix; the product name is **HisCCS**.

---

## 🛠 Development

```bash
# VSCode
cd vscode
npm install
npm run compile      # or npm run watch
npm run lint         # ESLint
npm test             # @vscode/test-electron
```

```bash
# JetBrains
cd jetbrains
./gradlew buildPlugin        # build
./gradlew runIde             # launch an IDE instance with the plugin
./gradlew verifyPlugin       # run the IntelliJ Plugin Verifier
```

---

## 🤝 Credits

- Built on the [VSCode Extension API](https://code.visualstudio.com/api) and the [IntelliJ Platform Gradle Plugin](https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html).
- Model capability is provided by DeepSeek / Qwen / OpenAI and others; keys and costs are the user's own.

## 📄 License

[MIT](vscode/LICENSE) © 2026 BlueCome
