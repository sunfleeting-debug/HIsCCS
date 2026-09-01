# HisCCS

还在手写 commit message？让 HisCCS 把提交写成艺术。

HisCCS 是一个 AI 驱动的 Git 提交信息生成插件，支持 **VSCode** 和 **JetBrains**（IDEA / PyCharm）。它读取你的 diff，一键生成符合 Conventional Commits 规范的提交信息：内置类型选择器，规范不再靠自觉；写到一半的句子，AI 帮你补完。

它的独特之处：生成前先用 **BM25** 检索你的历史提交作为风格参考——AI 生成的不是通用模板，而是"像你写的"提交信息。多模型支持（DeepSeek / 通义千问 / OpenAI），API 自由可控。

## 目录结构

| 目录 | 说明 |
|---|---|
| [vscode/](vscode/) | VSCode 插件（TypeScript） |
| [jetbrains/](jetbrains/) | JetBrains 插件（Kotlin，IDEA / PyCharm） |

## 安装

- **VSCode**：插件市场搜索 "HisCCS"，或在 [vscode/](vscode/) 中 `npm install && npm run package` 后安装生成的 `.vsix`
- **JetBrains**：插件市场搜索 "HisCCS"，或在 [jetbrains/](jetbrains/) 中运行 `./gradlew buildPlugin`，在 `build/distributions/` 安装生成的 `.zip`

## 使用

1. 在插件设置中填入 API Key（支持 DeepSeek / 通义千问 / OpenAI）
2. 修改代码后，点击按钮或使用快捷键触发生成
3. 从候选中选择，或输入前缀让 AI 补全

## License

MIT
