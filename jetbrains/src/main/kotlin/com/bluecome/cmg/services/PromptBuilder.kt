package com.bluecome.cmg.services

import java.util.Locale

object PromptBuilder {

    private val COMMIT_TYPES = """
- feat:     New feature
- fix:      Bug fix
- docs:     Documentation update
- style:    Code formatting (no functional change)
- refactor: Code refactoring
- perf:     Performance improvement
- test:     Test-related
- chore:    Build/toolchain changes
- revert:   Revert operation
""".trimIndent()

    private val COMMIT_TYPES_ZH = """
- feat:     新功能
- fix:      Bug 修复
- docs:     文档更新
- style:    代码格式（不影响功能）
- refactor: 代码重构
- perf:     性能优化
- test:     测试相关
- chore:    构建/工具链变更
- revert:   回退操作
""".trimIndent()

    /**
     * Build prompt with retrieval-augmented context.
     *
     * @param diff            current code diff
     * @param history         recent commit messages (for style reference)
     * @param similarCommits  top-K semantically similar historical commits (for few-shot examples)
     * @param count           number of candidates to generate
     * @param prefixMode      "standard" | "custom"
     * @param standardPrefix  fixed prefix type
     * @param customPrefix    custom prefix
     * @param language        target language
     */
    fun build(
        diff: String,
        history: List<String>,
        similarCommits: List<String>,
        count: Int,
        prefixMode: String,
        standardPrefix: String,
        customPrefix: String,
        language: String
    ): Pair<String, String> {
        val lang = resolveLanguage(language)
        return if (lang == "zh") buildZh(diff, history, similarCommits, count, prefixMode, standardPrefix, customPrefix)
        else buildEn(diff, history, similarCommits, count, prefixMode, standardPrefix, customPrefix, lang)
    }

    private fun buildZh(
        diff: String, history: List<String>, similarCommits: List<String>, count: Int,
        prefixMode: String, standardPrefix: String, customPrefix: String
    ): Pair<String, String> {
        val prefixInstruction = when {
            prefixMode == "custom" && customPrefix.isNotBlank() ->
                "\n固定使用前缀「$customPrefix」，AI 理解其语义后生成描述。"
            prefixMode == "standard" && standardPrefix.isNotBlank() ->
                "\n固定使用类型「$standardPrefix」。"
            else -> "\n根据变更内容自动选择最合适的类型前缀。"
        }

        // Build augmented section: combine history style reference + similar commit examples
        val augmentedSection = buildString {
            if (history.isNotEmpty()) {
                append("\n\n## 仓库近期提交风格参考\n")
                append(history.take(5).joinToString("\n") { "- $it" })
            }
            if (similarCommits.isNotEmpty()) {
                append("\n\n## 相似历史提交示例（用于参考表达风格）\n")
                append(similarCommits.take(3).joinToString("\n") { "- $it" })
            }
        }

        val system = """
你是一个专业的 Git Commit Message 生成助手。
根据提供的 git diff 内容，生成符合 Conventional Commits 规范的提交信息。

规范说明：
$COMMIT_TYPES_ZH

要求：
1. 生成 $count 条候选，每条独立一行，前缀序号如「1. 」
2. 每条标题控制在 50 字以内
3. 使用中文描述，说明做了什么、为什么做
4. 避免「更新」「优化」等模糊词汇，要具体$prefixInstruction$augmentedSection
""".trimIndent()

        var user = "请根据以下代码变更生成 $count 条 Git commit message 候选：\n\n```diff\n$diff\n```"
        return Pair(system, user)
    }

    private fun buildEn(
        diff: String, history: List<String>, similarCommits: List<String>, count: Int,
        prefixMode: String, standardPrefix: String, customPrefix: String, lang: String
    ): Pair<String, String> {
        val langName = when (lang) {
            "ja" -> "Japanese"; "fr" -> "French"; "de" -> "German"; "ru" -> "Russian"; else -> "English"
        }
        val prefixInstruction = when {
            prefixMode == "custom" && customPrefix.isNotBlank() ->
                "\nAlways use the prefix \"$customPrefix\" and generate a description matching its semantics."
            prefixMode == "standard" && standardPrefix.isNotBlank() ->
                "\nAlways use type \"$standardPrefix\"."
            else -> "\nAuto-select the most appropriate type prefix based on the changes."
        }

        // Build augmented section: combine history style reference + similar commit examples
        val augmentedSection = buildString {
            if (history.isNotEmpty()) {
                append("\n\n## Recent commit style reference\n")
                append(history.take(5).joinToString("\n") { "- $it" })
            }
            if (similarCommits.isNotEmpty()) {
                append("\n\n## Similar historical commit examples (for style reference)\n")
                append(similarCommits.take(3).joinToString("\n") { "- $it" })
            }
        }

        val system = """
You are a professional Git Commit Message generator.
Generate commit messages based on the git diff, following Conventional Commits standard.

Available types:
$COMMIT_TYPES

Requirements:
1. Generate exactly $count candidates, one per line, numbered like "1. "
2. Keep each title under 50 characters
3. Write descriptions in $langName
4. Be specific — avoid vague words like "update" or "improve"$prefixInstruction$augmentedSection
""".trimIndent()

        val userLabel = when (lang) {
            "ja" -> "以下のコード差分に対して $count 件の候補を生成してください："
            "fr" -> "Générez $count candidats pour le diff suivant :"
            "de" -> "Generieren Sie $count Kandidaten für den folgenden Diff:"
            "ru" -> "Сгенерируйте $count кандидатов для следующего diff:"
            else -> "Generate $count commit message candidates for the following diff:"
        }
        var user = "$userLabel\n\n```diff\n$diff\n```"
        return Pair(system, user)
    }

    /**
     * Build completion prompt with retrieval-augmented context.
     * Used when user has already typed a prefix.
     */
    fun buildCompletion(
        diff: String,
        history: List<String>,
        similarCommits: List<String>,
        userInput: String,
        language: String
    ): Pair<String, String> {
        val lang = resolveLanguage(language)
        val isZh = lang == "zh"

        val augmentedSection = buildString {
            if (history.isNotEmpty()) {
                append("\n\n## 仓库近期提交风格参考\n".let { if (isZh) it else it.replace("仓库近期提交风格参考", "Recent commit style") })
                append(history.take(5).joinToString("\n") { "- $it" })
            }
            if (similarCommits.isNotEmpty()) {
                append("\n\n## 相似历史提交示例\n".let { if (isZh) it else it.replace("相似历史提交示例", "Similar commit examples") })
                append(similarCommits.take(3).joinToString("\n") { "- $it" })
            }
        }

        if (isZh) {
            val system = """
你是一个专业的 Git Commit Message 补全助手。用户已写了部分提交信息，请根据 git diff 和历史提交风格补全它，保持 Conventional Commits 规范，用中文描述，只输出最终的提交信息，不要解释。${augmentedSection}
""".trimIndent()
            val user = "用户已输入：$userInput\n\n代码变更：\n```diff\n$diff\n```"
            return Pair(system, user)
        } else {
            val system = """
You are a Git commit message assistant. The user has typed a partial commit message. Complete or improve it based on the diff and recent commit style. Follow Conventional Commits. Output only the final message, no explanation.${augmentedSection}
""".trimIndent()
            val user = "User input: $userInput\n\nDiff:\n```diff\n$diff\n```"
            return Pair(system, user)
        }
    }

    fun resolveLanguage(lang: String): String {
        if (lang != "auto") return lang
        val locale = Locale.getDefault().language
        return when {
            locale.startsWith("zh") -> "zh"
            locale.startsWith("ja") -> "ja"
            locale.startsWith("fr") -> "fr"
            locale.startsWith("de") -> "de"
            locale.startsWith("ru") -> "ru"
            else -> "en"
        }
    }
}
