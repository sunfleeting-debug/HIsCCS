package com.bluecome.cmg.toolwindow

import com.bluecome.cmg.I18n
import com.bluecome.cmg.settings.CmgSettings
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.content.ContentFactory
import javax.swing.JTabbedPane

class HisCCSToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val uiLang = CmgSettings.getInstance().state.uiLanguage
        fun t(key: String) = I18n.t(uiLang, key)

        val tabs = JTabbedPane()

        val settingsPanel = SettingsPanel()
        tabs.addTab(t("tabSettings"), JBScrollPane(settingsPanel))

        val chatPanel = ChatPanel(project)
        tabs.addTab(t("tabChat"), chatPanel)

        val historyPanel = HistoryPanel(project)
        tabs.addTab(t("tabHistory"), historyPanel)

        val content = ContentFactory.getInstance().createContent(tabs, "", false)
        toolWindow.contentManager.addContent(content)
    }
}
