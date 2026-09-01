package com.bluecome.cmg.agent.tools

import com.bluecome.cmg.agent.AgentTool
import com.bluecome.cmg.agent.ToolContext
import com.bluecome.cmg.agent.ToolRegistry
import com.bluecome.cmg.agent.ToolResult
import org.json.JSONObject
import java.io.File

object GitTools {

    fun registerAll() {
        ToolRegistry.register(gitStatusTool)
        ToolRegistry.register(gitDiffTool)
        ToolRegistry.register(gitLogTool)
        ToolRegistry.register(gitCommitTool)
    }

    // ── git_status ─────────────────────────────────────

    private val gitStatusTool = object : AgentTool {
        override val name = "git_status"
        override val description = "Get the current git repository status (staged / modified files)."
        override val parametersJson = """
            {
                "type": "object",
                "properties": {},
                "required": []
            }
        """.trimIndent()

        override fun execute(ctx: ToolContext, args: JSONObject): ToolResult {
            if (ctx.isStopped()) return ToolResult(false, "Stopped by user.")
            return try {
                val root = File(ctx.workspaceRoot)

                // HEAD short hash — gracefully handle fresh repo (no commits yet)
                val head = try {
                    runGit(root, "rev-parse", "--short", "HEAD").trim()
                } catch (_: Exception) {
                    "(no commits)"
                }
                val lines = mutableListOf("HEAD: $head")

                // Staged files
                val staged = runGit(root, "diff", "--cached", "--name-status")
                if (staged.isNotBlank()) {
                    val allStaged = staged.lines().filter { it.isNotBlank() }
                    val shown = allStaged.take(50)
                    lines.add("Staged (${allStaged.size}):")
                    for (line in shown) {
                        lines.add("  $line")
                    }
                    if (allStaged.size > 50) lines.add("  ... (truncated)")
                }

                // Working tree files
                val workingTree = runGit(root, "status", "--porcelain")
                if (workingTree.isNotBlank()) {
                    val allWt = workingTree.lines().filter { it.isNotBlank() }
                    val shown = allWt.take(50)
                    lines.add("Working tree (${allWt.size}):")
                    for (line in shown) {
                        lines.add("  $line")
                    }
                    if (allWt.size > 50) lines.add("  ... (truncated)")
                }

                ToolResult(true, lines.joinToString("\n"))
            } catch (e: Exception) {
                ToolResult(false, "git error: ${e.message}")
            }
        }
    }

    // ── git_diff ───────────────────────────────────────

    private val gitDiffTool = object : AgentTool {
        override val name = "git_diff"
        override val description = "Get the current git diff. staged=true for staged changes, false for working tree."
        override val parametersJson = """
            {
                "type": "object",
                "properties": {
                    "staged": {
                        "type": "boolean",
                        "description": "Staged diff if true (default), else working-tree diff"
                    }
                },
                "required": []
            }
        """.trimIndent()

        override fun execute(ctx: ToolContext, args: JSONObject): ToolResult {
            if (ctx.isStopped()) return ToolResult(false, "Stopped by user.")
            return try {
                val root = File(ctx.workspaceRoot)
                val staged = args.optBoolean("staged", true)
                val diff = if (staged) {
                    runGit(root, "diff", "--cached")
                } else {
                    runGit(root, "diff")
                }
                if (diff.isBlank()) {
                    ToolResult(true, "(no diff)")
                } else {
                    ToolResult(true, diff)
                }
            } catch (e: Exception) {
                ToolResult(false, "git error: ${e.message}")
            }
        }
    }

    // ── git_log ────────────────────────────────────────

    private val gitLogTool = object : AgentTool {
        override val name = "git_log"
        override val description = "Get the last 10 git commits."
        override val parametersJson = """
            {
                "type": "object",
                "properties": {},
                "required": []
            }
        """.trimIndent()

        override fun execute(ctx: ToolContext, args: JSONObject): ToolResult {
            if (ctx.isStopped()) return ToolResult(false, "Stopped by user.")
            return try {
                val root = File(ctx.workspaceRoot)
                val log = runGit(root, "log", "--oneline", "-10")
                if (log.isBlank()) {
                    ToolResult(true, "(no commits)")
                } else {
                    ToolResult(true, log.trim())
                }
            } catch (e: Exception) {
                ToolResult(false, "git error: ${e.message}")
            }
        }
    }

    // ── git_commit ─────────────────────────────────────

    private val gitCommitTool = object : AgentTool {
        override val name = "git_commit"
        override val description = "Create a git commit from staged changes with the given message. Requires confirmation."
        override val parametersJson = """
            {
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "Commit message (subject line)"
                    }
                },
                "required": ["message"]
            }
        """.trimIndent()

        override fun needsApproval(ctx: ToolContext, args: JSONObject): Boolean = true

        override fun execute(ctx: ToolContext, args: JSONObject): ToolResult {
            if (ctx.isStopped()) return ToolResult(false, "Stopped by user.")
            val message = args.optString("message", "").trim()
            if (message.isEmpty()) {
                return ToolResult(false, "Empty commit message.")
            }
            return try {
                val root = File(ctx.workspaceRoot)
                runGit(root, "commit", "-m", message)
                ToolResult(true, "Committed: $message")
            } catch (e: Exception) {
                ToolResult(false, "git error: ${e.message}")
            }
        }
    }

    // ── helper ─────────────────────────────────────────

    private fun runGit(workDir: File, vararg args: String): String {
        val command = listOf("git") + args.toList()
        val pb = ProcessBuilder(command)
            .directory(workDir)
            .redirectErrorStream(true)
        val process = pb.start()
        val output = process.inputStream.bufferedReader().readText()
        val exitCode = process.waitFor()
        if (exitCode != 0) {
            throw RuntimeException("exit code $exitCode: ${output.take(500)}")
        }
        return output
    }
}
