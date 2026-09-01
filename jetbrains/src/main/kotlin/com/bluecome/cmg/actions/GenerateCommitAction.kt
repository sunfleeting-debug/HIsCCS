package com.bluecome.cmg.actions

import com.bluecome.cmg.I18n
import com.bluecome.cmg.services.AiService
import com.bluecome.cmg.services.DiffService
import com.bluecome.cmg.settings.CmgSettings
import com.bluecome.cmg.ui.CandidatesPopup
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.ui.Messages

class GenerateCommitAction : DumbAwareAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val settings = CmgSettings.getInstance()
        val s = settings.state
        val apiKey = settings.apiKey
        fun t(key: String, vararg args: Any) = I18n.t(s.uiLanguage, key, *args)

        if (apiKey.isBlank() && s.apiEndpoint.isBlank()) {
            Messages.showErrorDialog(project, t("errNoApiKey"), "HisCCS")
            return
        }

        val dataContext: DataContext = e.dataContext

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, t("msgGenerating"), true) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true

                val diff = DiffService.getStagedDiff(project)
                if (diff.isBlank()) {
                    ApplicationManager.getApplication().invokeLater {
                        Messages.showInfoMessage(project, t("msgNoStagedChanges"), "HisCCS")
                    }
                    return
                }

                indicator.text = "Calling AI…"

                // History for style reference
                val history = if (s.accordingHistory) DiffService.getCommitHistory(project, 10) else emptyList()

                // Full commit history for BM25 retrieval
                val allCommits = DiffService.getCommitHistory(project, 50)

                indicator.text = "Retrieving similar commits…"
                val similarCommits = if (s.accordingHistory && allCommits.isNotEmpty()) {
                    DiffService.getCommitHistory(project, 50)
                } else emptyList()

                val candidates = try {
                    AiService.generate(diff, history, similarCommits, s, apiKey)
                } catch (ex: Exception) {
                    ApplicationManager.getApplication().invokeLater {
                        Messages.showErrorDialog(project, t("errAiFailed", ex.message ?: ""), "HisCCS")
                    }
                    return
                }

                ApplicationManager.getApplication().invokeLater {
                    CandidatesPopup.show(dataContext, candidates, t("msgSelectCommit"))
                }
            }
        })
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }
}
