package com.bluecome.cmg.ui

import com.bluecome.cmg.I18n
import com.bluecome.cmg.settings.CmgSettings
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.vcs.VcsDataKeys

object CandidatesPopup {

    fun show(dataContext: DataContext, candidates: List<String>, title: String? = null) {
        if (candidates.isEmpty()) return
        val uiLang = CmgSettings.getInstance().state.uiLanguage
        val popupTitle = title ?: I18n.t(uiLang, "msgSelectCommit")

        val commitMessageControl = dataContext.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL)

        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(candidates)
            .setTitle(popupTitle)
            .setMovable(true)
            .setResizable(true)
            .setItemChosenCallback { selected ->
                if (commitMessageControl != null) {
                    commitMessageControl.setCommitMessage(selected)
                } else {
                    val clipboard = java.awt.Toolkit.getDefaultToolkit().systemClipboard
                    val content = java.awt.datatransfer.StringSelection(selected)
                    clipboard.setContents(content, null)
                    com.intellij.openapi.ui.Messages.showInfoMessage(
                        I18n.t(uiLang, "copiedToClipboard", selected),
                        "HisCCS"
                    )
                }
            }
            .createPopup()
            .showInBestPositionFor(dataContext)
    }
}
