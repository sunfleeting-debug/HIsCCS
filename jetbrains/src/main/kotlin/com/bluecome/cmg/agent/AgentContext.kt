package com.bluecome.cmg.agent

import org.json.JSONArray
import org.json.JSONObject

/** 与 VSCode 版 context.ts 的 ChatMessage 对齐（wire-format 字段不可改名） */
data class ToolCallSpec(val id: String, val name: String, val arguments: String)

data class ChatMessage(
    val role: String,
    val content: String,
    val toolCallId: String? = null,
    val toolCalls: List<ToolCallSpec> = emptyList()
) {
    fun toJson(): JSONObject {
        val o = JSONObject()
        o.put("role", role)
        o.put("content", content)
        if (toolCalls.isNotEmpty()) {
            val arr = JSONArray()
            for (tc in toolCalls) {
                arr.put(JSONObject()
                    .put("id", tc.id)
                    .put("type", "function")
                    .put("function", JSONObject().put("name", tc.name).put("arguments", tc.arguments)))
            }
            o.put("tool_calls", arr)
        }
        if (toolCallId != null) o.put("tool_call_id", toolCallId)
        return o
    }
}

fun truncateToolResult(content: String, maxChars: Int = 4000): String =
    if (content.length <= maxChars) content
    else content.take(maxChars) + "\n... (truncated, ${content.length - maxChars} more chars)"
