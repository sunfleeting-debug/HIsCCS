package com.bluecome.cmg.agent.tools

import com.bluecome.cmg.agent.AgentSecurity
import com.bluecome.cmg.agent.AgentTool
import com.bluecome.cmg.agent.ToolContext
import com.bluecome.cmg.agent.ToolRegistry
import com.bluecome.cmg.agent.ToolResult
import com.bluecome.cmg.agent.truncateToolResult
import org.json.JSONObject
import java.io.File
import java.nio.file.FileSystems
import java.nio.file.Paths
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * 文件操作工具集合：read_file / write_file / edit_file / list_dir / search_files / run_command
 *
 * 路径校验规则：
 *   - 工作区外需要 confirm（read_file / list_dir）
 *   - 工作区外直接拒绝（write_file / edit_file / run_command）
 *   - search_files 仅在工作区内搜索
 */
object FileTools {

    fun registerAll() {
        ToolRegistry.register(readFileTool)
        ToolRegistry.register(writeFileTool)
        ToolRegistry.register(editFileTool)
        ToolRegistry.register(listDirTool)
        ToolRegistry.register(searchFilesTool)
        ToolRegistry.register(runCommandTool)
    }

    // ── helpers ──────────────────────────────────────

    /** 解析 workspace 相对路径并校验在工作区内，否则返回 null */
    private fun resolveWorkDirPath(ctx: ToolContext, rawPath: Any?): File? {
        val p = File(ctx.workspaceRoot).resolve(rawPath?.toString() ?: "")
        return if (AgentSecurity.isWithinWorkspace(ctx.workspaceRoot, p.absolutePath)) p else null
    }

    /** 工作区外时弹 confirm，用户同意才返回路径 */
    private fun resolveWorkDirPathWithConfirm(
        ctx: ToolContext,
        rawPath: Any?,
        promptLabel: String
    ): File? {
        val p = File(ctx.workspaceRoot).resolve(rawPath?.toString() ?: "")
        if (AgentSecurity.isWithinWorkspace(ctx.workspaceRoot, p.absolutePath)) return p
        return if (ctx.confirm(promptLabel, p.absolutePath)) p else null
    }

    // ── read_file ────────────────────────────────────

    private val readFileTool = object : AgentTool {
        override val name: String = "read_file"
        override val description: String = "Read a text file. Supports line offset/limit to avoid huge outputs."
        override val parametersJson: String = """
            {
              "type": "object",
              "properties": {
                "path":   { "type": "string", "description": "Absolute or workspace-relative file path" },
                "offset": { "type": "number", "description": "Start line, 1-based (default 1)" },
                "limit":  { "type": "number", "description": "Max lines to return (default 500, max 1000)" }
              },
              "required": ["path"]
            }
        """.trimIndent()

        override fun execute(ctx: ToolContext, args: JSONObject): ToolResult {
            val file = resolveWorkDirPathWithConfirm(
                ctx, args.opt("path"), "读取工作区外文件："
            ) ?: return ToolResult(false, "User denied reading file outside the workspace.")
            if (!file.exists()) return ToolResult(false, "File not found: ${file.absolutePath}")
            if (!file.isFile) return ToolResult(false, "Not a file: ${file.absolutePath}")

            val offset = maxOf(1, args.optInt("offset", 1))
            val limit  = minOf(1000, maxOf(1, args.optInt("limit", 500)))

            return try {
                val lines = file.readLines()
                val from  = offset - 1
                val to    = minOf(from + limit, lines.size)
                val slice = if (from < lines.size) lines.subList(from, to) else emptyList()
                val truncated = lines.size > from + limit
                ToolResult(
                    true,
                    slice.joinToString("\n") +
                        if (truncated) "\n... (${lines.size - from - limit} more lines)" else "",
                    truncated
                )
            } catch (e: Exception) {
                ToolResult(false, "Failed to read ${file.absolutePath}: ${e.message}")
            }
        }
    }

    // ── write_file ───────────────────────────────────

    private val writeFileTool = object : AgentTool {
        override val name: String = "write_file"
        override val description: String = "Create or overwrite a file with the given content. Requires user confirmation."
        override val parametersJson: String = """
            {
              "type": "object",
              "properties": {
                "path":    { "type": "string", "description": "Absolute or workspace-relative file path" },
                "content": { "type": "string", "description": "Full new file content" }
              },
              "required": ["path", "content"]
            }
        """.trimIndent()

        override fun needsApproval(ctx: ToolContext, args: JSONObject): Boolean = true

        override fun execute(ctx: ToolContext, args: JSONObject): ToolResult {
            val p = resolveWorkDirPath(ctx, args.opt("path"))
                ?: return ToolResult(false, "Refused: ${args.optString("path")} is outside the workspace.")
            val content = args.optString("content", "")
            return try {
                p.parentFile?.let { if (!it.exists()) it.mkdirs() }
                p.writeText(content)
                ToolResult(true, "Wrote ${content.length} chars to ${p.absolutePath}")
            } catch (e: Exception) {
                ToolResult(false, "Failed to write ${p.absolutePath}: ${e.message}")
            }
        }
    }

    // ── edit_file ────────────────────────────────────

    private val editFileTool = object : AgentTool {
        override val name: String = "edit_file"
        override val description: String = "Replace a unique occurrence of oldText with newText in a file. Requires user confirmation."
        override val parametersJson: String = """
            {
              "type": "object",
              "properties": {
                "path":    { "type": "string", "description": "Absolute or workspace-relative file path" },
                "oldText": { "type": "string", "description": "Exact text to replace" },
                "newText": { "type": "string", "description": "Replacement text" }
              },
              "required": ["path", "oldText", "newText"]
            }
        """.trimIndent()

        override fun needsApproval(ctx: ToolContext, args: JSONObject): Boolean = true

        override fun execute(ctx: ToolContext, args: JSONObject): ToolResult {
            val p = resolveWorkDirPath(ctx, args.opt("path"))
                ?: return ToolResult(false, "Refused: ${args.optString("path")} is outside the workspace.")
            val oldText = args.optString("oldText", "")
            val newText = args.optString("newText", "")
            if (oldText.isEmpty()) return ToolResult(false, "oldText must not be empty.")

            return try {
                val text = p.readText()
                val idx  = text.indexOf(oldText)
                if (idx == -1) return ToolResult(false, "oldText not found in ${p.absolutePath}")
                if (text.indexOf(oldText, idx + 1) != -1) {
                    return ToolResult(false, "oldText is ambiguous (multiple matches) in ${p.absolutePath}")
                }
                val updated = text.substring(0, idx) + newText + text.substring(idx + oldText.length)
                p.writeText(updated)
                ToolResult(true, "Edited ${p.absolutePath} (1 replacement)")
            } catch (e: Exception) {
                ToolResult(false, "Failed to edit ${p.absolutePath}: ${e.message}")
            }
        }
    }

    // ── list_dir ─────────────────────────────────────

    private val listDirTool = object : AgentTool {
        override val name: String = "list_dir"
        override val description: String = "List directory entries (type + name). Up to 200 entries."
        override val parametersJson: String = """
            {
              "type": "object",
              "properties": {
                "path": { "type": "string", "description": "Absolute or workspace-relative directory path" }
              },
              "required": ["path"]
            }
        """.trimIndent()

        override fun execute(ctx: ToolContext, args: JSONObject): ToolResult {
            val dir = resolveWorkDirPathWithConfirm(
                ctx, args.opt("path"), "读取工作区外目录："
            ) ?: return ToolResult(false, "User denied.")
            if (!dir.isDirectory) return ToolResult(false, "Not a directory: ${dir.absolutePath}")

            return try {
                val entries = dir.list() ?: emptyArray()
                val count   = minOf(entries.size, 200)
                val lines   = entries.sliceArray(0 until count).map { name ->
                    val f = File(dir, name)
                    "${if (f.isDirectory) "dir " else "file"} $name"
                }
                val truncated = entries.size > 200
                ToolResult(
                    true,
                    "Entries in ${dir.absolutePath} (${entries.size}):\n${lines.joinToString("\n")}" +
                        if (truncated) "\n... (truncated)" else "",
                    truncated
                )
            } catch (e: Exception) {
                ToolResult(false, "Failed to list ${dir.absolutePath}: ${e.message}")
            }
        }
    }

    // ── search_files ─────────────────────────────────

    private val searchFilesTool = object : AgentTool {
        override val name: String = "search_files"
        override val description: String = "Search file contents for text within the workspace. Returns up to 50 matches with file:line:preview."
        override val parametersJson: String = """
            {
              "type": "object",
              "properties": {
                "query": { "type": "string", "description": "Text to search for" },
                "path":  { "type": "string", "description": "Optional workspace-relative subdirectory to limit search" },
                "glob":  { "type": "string", "description": "Optional glob filter, e.g. **/*.kt" }
              },
              "required": ["query"]
            }
        """.trimIndent()

        override fun execute(ctx: ToolContext, args: JSONObject): ToolResult {
            val query = args.optString("query", "")
            if (query.isEmpty()) return ToolResult(false, "Empty search query.")

            val sub        = args.optString("path", "").replace(Regex("^/+|/+$"), "")
            val globRaw    = args.optString("glob", "")
            val searchRoot = if (sub.isNotEmpty()) File(ctx.workspaceRoot, sub) else File(ctx.workspaceRoot)

            if (!AgentSecurity.isWithinWorkspace(ctx.workspaceRoot, searchRoot.absolutePath)) {
                return ToolResult(false, "Search root is outside the workspace.")
            }
            if (!searchRoot.exists()) return ToolResult(false, "Search root does not exist: ${searchRoot.absolutePath}")

            val excludeDirs  = setOf(".git", "build", ".gradle", ".idea", "node_modules", "__pycache__")
            val maxFileSize  = 1L * 1024 * 1024   // 1 MB
            val maxMatches   = 50
            val maxPreview   = 120

            // glob 过滤（空或 **/* 表示不限）
            val matcher = if (globRaw.isNotEmpty() && globRaw != "**/*") {
                try { FileSystems.getDefault().getPathMatcher("glob:$globRaw") } catch (_: Exception) { null }
            } else null

            val matches = mutableListOf<String>()
            val walk = searchRoot.walkTopDown().onEnter { dir -> dir.name !in excludeDirs }
            for (file in walk) {
                if (matches.size >= maxMatches) break
                if (!file.isFile) continue
                if (file.length() > maxFileSize) continue

                val rel = File(ctx.workspaceRoot).toRelativeString(file)
                if (matcher != null && !matcher.matches(Paths.get(rel))) continue

                val text = try { file.readText() } catch (_: Exception) { continue }

                for ((lineNo, line) in text.lineSequence().mapIndexed { i, l -> i + 1 to l }) {
                    if (matches.size >= maxMatches) break
                    if (line.contains(query)) {
                        matches.add("$rel:$lineNo: ${line.trim().take(maxPreview)}")
                    }
                }
            }

            if (matches.isEmpty()) {
                return ToolResult(true, "No matches for \"" + query + "\".")
            }
            val truncated = matches.size >= maxMatches
            return ToolResult(
                true,
                "Matches for \"" + query + "\":\n" + matches.joinToString("\n") +
                    if (truncated) "\n... (truncated)" else "",
                truncated
            )
        }
    }

    // ── run_command ──────────────────────────────────

    private val runCommandTool = object : AgentTool {
        override val name: String = "run_command"
        override val description: String = "Execute a shell command and capture stdout/stderr. Requires approval; dangerous commands are blocked."
        override val parametersJson: String = """
            {
              "type": "object",
              "properties": {
                "command":   { "type": "string", "description": "Shell command to run" },
                "cwd":       { "type": "string", "description": "Optional working directory (workspace-relative or absolute)" },
                "timeoutMs": { "type": "number", "description": "Optional timeout in ms (default 30000, max 120000)" }
              },
              "required": ["command"]
            }
        """.trimIndent()

        override fun needsApproval(ctx: ToolContext, args: JSONObject): Boolean {
            val cmd = args.optString("command", "").trim()
            return !AgentSecurity.isDangerousCommand(cmd)
        }

        override fun execute(ctx: ToolContext, args: JSONObject): ToolResult {
            val command = args.optString("command", "").trim()
            if (command.isEmpty()) return ToolResult(false, "Empty command.")
            if (AgentSecurity.isDangerousCommand(command)) {
                return ToolResult(false, "Blocked: dangerous command \"" + command + "\"")
            }

            val cwdStr = args.optString("cwd", "")
            val cwd = if (cwdStr.isNotEmpty()) File(ctx.workspaceRoot).resolve(cwdStr) else File(ctx.workspaceRoot)
            if (!AgentSecurity.isWithinWorkspace(ctx.workspaceRoot, cwd.absolutePath)) {
                return ToolResult(false, "Refused: cwd " + cwd.absolutePath + " is outside the workspace.")
            }
            val timeoutMs = minOf(120_000L, maxOf(1L, args.optLong("timeoutMs", 30_000L)))
            val isWin = System.getProperty("os.name").lowercase().contains("win")

            val proc = try {
                ProcessBuilder(
                    if (isWin) listOf("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command)
                    else listOf("/bin/sh", "-c", command)
                ).directory(cwd).redirectErrorStream(true).start()
            } catch (e: Exception) {
                return ToolResult(false, "Failed to spawn: ${e.message}")
            }

            val stopped  = AtomicBoolean(false)
            val timedOut = AtomicBoolean(false)
            val output   = StringBuilder()

            // 输出读取线程
            val reader = thread(name = "filetools-reader", isDaemon = true) {
                proc.inputStream.bufferedReader(Charsets.UTF_8).use { br ->
                    val buf = CharArray(8192)
                    while (!stopped.get()) {
                        val n = br.read(buf)
                        if (n < 0) break
                        output.append(buf, 0, n)
                    }
                }
            }

            // 停止信号轮询线程：每 100ms 检查一次 ctx.isStopped()
            val stopper = thread(name = "filetools-stopper", isDaemon = true) {
                while (!stopped.get() && !timedOut.get()) {
                    Thread.sleep(100)
                    if (ctx.isStopped()) {
                        stopped.set(true)
                        try { proc.destroyForcibly() } catch (_: Exception) {}
                        break
                    }
                }
            }

            // 超时监控线程
            val timer = thread(name = "filetools-timer", isDaemon = true) {
                Thread.sleep(timeoutMs)
                if (!stopped.get()) {
                    timedOut.set(true)
                    try { proc.destroyForcibly() } catch (_: Exception) {}
                }
            }

            reader.join()
            stopper.interrupt()
            timer.interrupt()

            val exitCode = try { proc.waitFor() } catch (_: InterruptedException) { -1 }

            if (stopped.get()) {
                return ToolResult(false, "Command aborted by user.")
            }
            if (timedOut.get()) {
                return ToolResult(
                    false,
                    "Command timed out after " + timeoutMs + "ms\n\nstdout:\n" + output + "\n\nstderr:\n"
                )
            }
            val full = "Exit code: $exitCode\n\nstdout:\n$output\n\nstderr:\n"
            return ToolResult(
                exitCode == 0,
                truncateToolResult(full, 4000),
                output.length > 4000
            )
        }
    }
}
