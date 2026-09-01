package com.bluecome.cmg.agent

import com.intellij.openapi.project.Project
import org.json.JSONObject

data class ToolResult(val ok: Boolean, val content: String, val truncated: Boolean = false)

class ToolContext(
    val project: Project,
    val workspaceRoot: String,
    val confirm: (summary: String, detail: String?) -> Boolean,
    val isStopped: () -> Boolean
)

sealed class ToolEvent {
    data class Start(val name: String, val args: JSONObject) : ToolEvent()
    data class Result(val name: String, val ok: Boolean, val content: String) : ToolEvent()
    data class Approval(val name: String, val summary: String) : ToolEvent()
}

interface AgentTool {
    val name: String
    val description: String
    /** JSON Schema 字符串，嵌入请求体 tools 参数 */
    val parametersJson: String
    fun needsApproval(ctx: ToolContext, args: JSONObject): Boolean = false
    fun execute(ctx: ToolContext, args: JSONObject): ToolResult
}

object ToolRegistry {
    private val tools = linkedMapOf<String, AgentTool>()
    fun register(tool: AgentTool) { tools[tool.name] = tool }
    fun get(name: String): AgentTool? = tools[name]
    fun list(): List<AgentTool> = tools.values.toList()
}
