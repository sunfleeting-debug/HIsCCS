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
import com.intellij.openapi.vcs.VcsDataKeys
import com.intellij.openapi.vcs.ui.CommitMessage

class AutocompleteAction : DumbAwareAction() {

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

        val commitControl = e.dataContext.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL)
        val userInput = (commitControl as? CommitMessage)?.editorField?.text?.trim() ?: ""
        if (userInput.isBlank()) {
            Messages.showInfoMessage(project, t("msgTypeFirst"), "HisCCS")
            return
        }

        val dataContext: DataContext = e.dataContext

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, t("msgCompleting"), true) {
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
                val history = if (s.accordingHistory) DiffService.getCommitHistory(project, 10) else emptyList()
                val allCommits = DiffService.getCommitHistory(project, 50)

                val candidates = try {
                    AiService.generateCompletion(diff, history, allCommits, userInput, s, apiKey)
                } catch (ex: Exception) {
                    ApplicationManager.getApplication().invokeLater {
                        Messages.showErrorDialog(project, t("errAiFailed", ex.message ?: ""), "HisCCS")
                    }
                    return
                }

                ApplicationManager.getApplication().invokeLater {
                    if (candidates.isEmpty()) {
                        Messages.showInfoMessage(project, t("msgNoResults"), "HisCCS")
                    } else {
                        CandidatesPopup.show(dataContext, candidates, t("msgSelectCommit"))
                    }
                }
            }
        })
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }
}
