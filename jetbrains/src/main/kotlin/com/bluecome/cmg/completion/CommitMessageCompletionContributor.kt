package com.bluecome.cmg.completion

import com.bluecome.cmg.services.AiService
import com.bluecome.cmg.services.DiffService
import com.bluecome.cmg.settings.CmgSettings
import com.intellij.codeInsight.completion.*
import com.intellij.codeInsight.lookup.LookupElementBuilder
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.vcs.VcsDataKeys
import com.intellij.patterns.PlatformPatterns
import com.intellij.util.ProcessingContext

class CommitMessageCompletionContributor : CompletionContributor() {
    init {
        extend(
            CompletionType.BASIC,
            PlatformPatterns.psiElement(),
            CommitMessageCompletionProvider()
        )
    }
}

class CommitMessageCompletionProvider : CompletionProvider<CompletionParameters>() {
    override fun addCompletions(
        parameters: CompletionParameters,
        context: ProcessingContext,
        result: CompletionResultSet
    ) {
        val editor = parameters.editor
        val project = editor.project ?: return
        val doc = editor.document

        // Only trigger in the VCS commit message editor (single-line or small doc)
        if (doc.lineCount > 5) return

        val text = doc.text.replace(CompletionUtilCore.DUMMY_IDENTIFIER_TRIMMED, "").trim()
        if (text.length < 3) return

        val settings = CmgSettings.getInstance()
        val s = settings.state
        val apiKey = settings.apiKey
        if (apiKey.isBlank() && s.apiEndpoint.isBlank()) return

        val candidates = try {
            val diff = DiffService.getStagedDiff(project)
            val history = if (s.accordingHistory) DiffService.getCommitHistory(project, 5) else emptyList()
            val allCommits = DiffService.getCommitHistory(project, 50)
            AiService.generateCompletion(diff, history, allCommits, text, s, apiKey)
        } catch (_: Exception) {
            return
        }

        candidates.forEach { candidate ->
            result.addElement(
                LookupElementBuilder.create(candidate)
                    .withTypeText("HisCCS AI")
                    .withBoldness(false)
            )
        }
    }
}
