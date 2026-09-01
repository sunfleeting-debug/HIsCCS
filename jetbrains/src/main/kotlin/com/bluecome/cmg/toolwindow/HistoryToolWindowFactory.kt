package com.bluecome.cmg.toolwindow

import com.bluecome.cmg.I18n
import com.bluecome.cmg.settings.CmgSettings
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileTypes.FileTypeRegistry
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextField
import com.intellij.ui.content.ContentFactory
import git4idea.GitCommit
import git4idea.commands.Git
import git4idea.commands.GitCommand
import git4idea.commands.GitLineHandler
import git4idea.history.GitHistoryUtils
import git4idea.repo.GitRepositoryManager
import java.awt.*
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.*
import javax.swing.border.EmptyBorder

class HistoryToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = HistoryPanel(project)
        val content = ContentFactory.getInstance().createContent(panel, "", false)
        toolWindow.contentManager.addContent(content)
    }
}

class HistoryPanel(private val project: Project) : JPanel(BorderLayout()) {

    private val listModel = DefaultListModel<GitCommit>()
    private val commitList = JBList(listModel)
    private val detailPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        border = EmptyBorder(8, 10, 8, 10)
    }
    private val detailScroll = JBScrollPane(detailPanel)
    private val searchField = JBTextField()
    private val allCommits = mutableListOf<GitCommit>()

    private fun t(key: String, vararg args: Any) =
        I18n.t(CmgSettings.getInstance().state.uiLanguage, key, *args)

    init {
        searchField.emptyText.text = "🔍 ${t("btnRefresh")}"

        val splitPane = JSplitPane(JSplitPane.VERTICAL_SPLIT,
            JBScrollPane(commitList), detailScroll
        ).apply { resizeWeight = 0.45 }

        val topPanel = JPanel(BorderLayout(4, 4)).apply {
            border = EmptyBorder(6, 8, 6, 8)
            add(searchField, BorderLayout.CENTER)
            add(JButton(t("btnRefresh")).apply {
                font = font.deriveFont(11f)
                addActionListener { loadHistory() }
            }, BorderLayout.EAST)
        }

        add(topPanel, BorderLayout.NORTH)
        add(splitPane, BorderLayout.CENTER)

        commitList.selectionMode = ListSelectionModel.SINGLE_SELECTION
        commitList.cellRenderer = CommitCellRenderer()
        commitList.addListSelectionListener {
            if (!it.valueIsAdjusting) {
                val idx = commitList.selectedIndex
                if (idx >= 0 && idx < listModel.size) renderDetail(listModel.getElementAt(idx))
            }
        }

        searchField.document.addDocumentListener(object : javax.swing.event.DocumentListener {
            override fun insertUpdate(e: javax.swing.event.DocumentEvent) = applyFilter()
            override fun removeUpdate(e: javax.swing.event.DocumentEvent) = applyFilter()
            override fun changedUpdate(e: javax.swing.event.DocumentEvent) = applyFilter()
        })

        loadHistory()
    }

    private fun applyFilter() {
        val q = searchField.text.trim().lowercase()
        listModel.clear()
        val filtered = if (q.isBlank()) allCommits else allCommits.filter {
            it.subject.lowercase().contains(q) ||
                it.id.toShortString().contains(q) ||
                it.author.name.lowercase().contains(q)
        }
        filtered.forEach { listModel.addElement(it) }
        detailPanel.removeAll(); detailPanel.revalidate(); detailPanel.repaint()
    }

    private fun loadHistory() {
        detailPanel.removeAll()
        val loading = JLabel(t("historyLoading")).apply {
            foreground = UIManager.getColor("Label.disabledForeground") ?: Color.GRAY
        }
        detailPanel.add(loading)
        detailPanel.revalidate()

        ApplicationManager.getApplication().executeOnPooledThread {
            val repo = GitRepositoryManager.getInstance(project).repositories.firstOrNull()
            if (repo == null) {
                SwingUtilities.invokeLater {
                    detailPanel.removeAll()
                    detailPanel.add(JLabel(t("historyNoRepo")))
                    detailPanel.revalidate()
                }
                return@executeOnPooledThread
            }
            val history = try {
                GitHistoryUtils.history(project, repo.root, "-500")
            } catch (e: Exception) {
                SwingUtilities.invokeLater {
                    detailPanel.removeAll()
                    detailPanel.add(JLabel(t("historyError", e.message ?: "")))
                    detailPanel.revalidate()
                }
                return@executeOnPooledThread
            }
            SwingUtilities.invokeLater {
                allCommits.clear(); allCommits.addAll(history)
                applyFilter()
            }
        }
    }

    private fun renderDetail(c: GitCommit) {
        detailPanel.removeAll()

        fun row(label: String, value: String) {
            val p = JPanel(BorderLayout(6, 0)).apply {
                isOpaque = false; border = EmptyBorder(1, 0, 1, 0)
                val lbl = JLabel("$label:").apply {
                    font = font.deriveFont(Font.BOLD, 11f)
                    foreground = UIManager.getColor("Label.disabledForeground") ?: Color.GRAY
                    preferredSize = Dimension(52, preferredSize.height)
                }
                val v = JLabel(value).apply { font = font.deriveFont(11f) }
                add(lbl, BorderLayout.WEST); add(v, BorderLayout.CENTER)
            }
            detailPanel.add(p)
        }

        row(t("historyCommit"), c.id.asString())
        row(t("historyAuthor"), "${c.author.name} <${c.author.email}>")
        row(t("historyDate"), c.authorTime.toString())

        if (c.fullMessage.isNotBlank()) {
            detailPanel.add(JSeparator().apply { maximumSize = Dimension(Int.MAX_VALUE, 1) })
            val msg = JTextArea(c.fullMessage).apply {
                isEditable = false; lineWrap = true; wrapStyleWord = true
                isOpaque = false; border = EmptyBorder(4, 0, 4, 0)
                font = Font(Font.SANS_SERIF, Font.PLAIN, 12)
            }
            detailPanel.add(msg)
        }

        val paths = c.affectedPaths.toList()
        if (paths.isNotEmpty()) {
            detailPanel.add(JSeparator().apply { maximumSize = Dimension(Int.MAX_VALUE, 1) })
            val filesLabel = JLabel(t("historyFiles")).apply {
                font = font.deriveFont(Font.BOLD, 11f)
                border = EmptyBorder(4, 0, 2, 0)
                foreground = UIManager.getColor("Label.disabledForeground") ?: Color.GRAY
            }
            detailPanel.add(filesLabel)
            paths.forEach { changed ->
                // Use presentableUrl directly (it's already a string, not nullable)
                val pathStr = changed.presentableUrl
                // Normalize path: use forward slashes for git commands
                val gitPath = pathStr.replace("\\", "/")
                val fileRow = JPanel(FlowLayout(FlowLayout.LEFT, 4, 1)).apply {
                    isOpaque = false; cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                    val badge = JLabel("M").apply {
                        font = font.deriveFont(Font.BOLD, 9f)
                        foreground = Color(217, 166, 0)
                        border = BorderFactory.createCompoundBorder(
                            BorderFactory.createLineBorder(Color(217, 166, 0, 80)),
                            EmptyBorder(0, 3, 0, 3)
                        )
                        isOpaque = true
                        background = Color(217, 166, 0, 30)
                    }
                    val link = JLabel(pathStr).apply {
                        font = font.deriveFont(12f)
                        foreground = UIManager.getColor("Link.activeForeground") ?: Color(88, 166, 255)
                        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                        toolTipText = "Click to open diff for this file"
                    }
                    val handler = object : MouseAdapter() {
                        override fun mousePressed(e: MouseEvent) { openFileAtCommit(c, gitPath) }
                        override fun mouseEntered(e: MouseEvent) { link.foreground = Color(0, 102, 204) }
                        override fun mouseExited(e: MouseEvent) {
                            link.foreground = UIManager.getColor("Link.activeForeground") ?: Color(88, 166, 255)
                        }
                    }
                    link.addMouseListener(handler)
                    addMouseListener(handler)
                    badge.addMouseListener(handler)
                    add(badge); add(link)
                }
                detailPanel.add(fileRow)
            }
        }

        detailPanel.revalidate(); detailPanel.repaint()
        detailScroll.viewport.viewPosition = Point(0, 0)
    }

    private fun openFileAtCommit(commit: GitCommit, path: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val repo = GitRepositoryManager.getInstance(project).repositories.firstOrNull()
                    ?: run {
                        SwingUtilities.invokeLater {
                            JOptionPane.showMessageDialog(this, "No git repository found in this project.",
                                "Open File", JOptionPane.WARNING_MESSAGE)
                        }
                        return@executeOnPooledThread
                    }
                val commitHash = commit.id.asString()
                val parentHash = commit.parents.firstOrNull()?.asString()
                    ?: "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

                // Use clean path (remove leading slash if any)
                val cleanPath = path.removePrefix("/").trim()

                // Always use `git show` — works even if the file no longer exists in the working tree.
                val currentContent = gitShowFile(repo.root.path, commitHash, cleanPath)
                val parentContent = gitShowFile(repo.root.path, parentHash, cleanPath)
                val fileType = FileTypeRegistry.getInstance().getFileTypeByFileName(cleanPath)

                // Create DiffContent using text content directly with project
                val currentDiff = DiffContentFactory.getInstance().create(project, currentContent, fileType)
                val parentDiff = DiffContentFactory.getInstance().create(project, parentContent, fileType)

                SwingUtilities.invokeLater {
                    val request = SimpleDiffRequest(
                        "${path} (${commitHash.take(7)} vs ${parentHash.take(7)})",
                        listOf(currentDiff, parentDiff),
                        listOf("Commit ${commitHash.take(7)}", "Parent ${parentHash.take(7)}")
                    )
                    DiffManager.getInstance().showDiff(project, request)
                }
            } catch (e: Exception) {
                SwingUtilities.invokeLater {
                    JOptionPane.showMessageDialog(this,
                        "Cannot open diff for $path:\n${e.message ?: e.javaClass.simpleName}",
                        "Diff Error", JOptionPane.ERROR_MESSAGE)
                }
            }
        }
    }

    /** Run `git show <rev>:<path>` and return its stdout. Returns "" if file is absent in that revision. */
    private fun gitShowFile(repoRoot: String, revision: String, path: String): String {
        return try {
            val pb = ProcessBuilder("git", "show", "${revision}:${path}")
                .directory(java.io.File(repoRoot))
                .redirectErrorStream(true) // merge stderr into stdout for easier debugging
            val proc = pb.start()
            val out = proc.inputStream.bufferedReader().readText()
            proc.waitFor()
            if (proc.exitValue() != 0) {
                // If git show fails (e.g., file doesn't exist in that revision), return empty string
                ""
            } else {
                out
            }
        } catch (_: Exception) { "" }
    }

    inner class CommitCellRenderer : DefaultListCellRenderer() {
        override fun getListCellRendererComponent(
            list: JList<*>, value: Any?, index: Int, isSelected: Boolean, cellHasFocus: Boolean
        ): Component {
            val c = value as? GitCommit ?: return super.getListCellRendererComponent(list, value, index, isSelected, cellHasFocus)
            val panel = JPanel(BorderLayout(4, 2)).apply {
                border = EmptyBorder(6, 10, 6, 10)
                if (isSelected) {
                    background = list.selectionBackground
                    isOpaque = true
                } else {
                    isOpaque = false
                }
            }
            val hash = JLabel(c.id.toShortString()).apply {
                font = Font(Font.MONOSPACED, Font.BOLD, 11)
                foreground = if (isSelected) list.selectionForeground
                else UIManager.getColor("Link.activeForeground") ?: Color(88, 166, 255)
            }
            val subject = JLabel(c.subject).apply {
                font = Font(Font.SANS_SERIF, Font.PLAIN, 12)
                foreground = if (isSelected) list.selectionForeground
                else UIManager.getColor("Label.foreground") ?: Color.BLACK
            }
            val meta = JLabel("${c.author.name}  ${c.authorTime}").apply {
                font = Font(Font.SANS_SERIF, Font.PLAIN, 10)
                foreground = if (isSelected) list.selectionForeground
                else UIManager.getColor("Label.disabledForeground") ?: Color.GRAY
            }
            val top = JPanel(BorderLayout(8, 0)).apply {
                isOpaque = false; add(hash, BorderLayout.WEST); add(subject, BorderLayout.CENTER)
            }
            panel.add(top, BorderLayout.NORTH)
            panel.add(meta, BorderLayout.SOUTH)
            return panel
        }
    }
}
