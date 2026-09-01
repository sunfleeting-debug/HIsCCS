package com.bluecome.cmg.actions

import com.bluecome.cmg.I18n
import com.bluecome.cmg.settings.CmgSettings
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.vcs.VcsDataKeys
import com.intellij.openapi.vcs.ui.CommitMessage

data class CommitType(val prefix: String, val description: String)

class SelectTypeAction : DumbAwareAction() {

    override fun actionPerformed(e: AnActionEvent) {
        val commitControl = e.dataContext.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL) ?: return
        val uiLang = CmgSettings.getInstance().state.uiLanguage
        fun t(key: String) = I18n.t(uiLang, key)

        val TYPES = listOf(
            CommitType("feat",     t("typeFeat")),
            CommitType("fix",      t("typeFix")),
            CommitType("docs",     t("typeDocs")),
            CommitType("style",    t("typeStyle")),
            CommitType("refactor", t("typeRefactor")),
            CommitType("perf",     t("typePerf")),
            CommitType("test",     t("typeTest")),
            CommitType("chore",    t("typeChore")),
            CommitType("revert",   t("typeRevert")),
        )
        val labels = TYPES.map { "${it.prefix}: — ${it.description}" }

        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(labels)
            .setTitle(t("selectTypeTitle"))
            .setMovable(false)
            .setItemChosenCallback { selected ->
                val prefix = selected.substringBefore(":") + ": "
                val current = (commitControl as? CommitMessage)?.editorField?.text.orEmpty()
                if (current.isBlank()) {
                    commitControl.setCommitMessage(prefix)
                } else {
                    val replaced = if (current.matches(Regex("^[a-z]+:\\s.*", RegexOption.DOT_MATCHES_ALL))) {
                        current.replaceFirst(Regex("^[a-z]+:\\s*"), prefix)
                    } else {
                        prefix + current
                    }
                    commitControl.setCommitMessage(replaced)
                }
            }
            .createPopup()
            .showInBestPositionFor(e.dataContext)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }
}
