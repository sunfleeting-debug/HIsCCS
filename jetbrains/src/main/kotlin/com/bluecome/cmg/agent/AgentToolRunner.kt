package com.bluecome.cmg.agent

import com.bluecome.cmg.settings.CmgSettings
import com.intellij.openapi.project.Project
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSource
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

private const val TAG_L = "<"
private const val TAG_R = ">"
private const val TAG_SLASH = "/"

private val TOOL_CALL_OPEN = TAG_L + "tool_call" + TAG_R
private val TOOL_CALL_CLOSE = TAG_L + TAG_SLASH + "tool_call" + TAG_R
private val TOOL_RESULT_OPEN = TAG_L + "tool_result"
private val TOOL_RESULT_CLOSE = TAG_L + TAG_SLASH + "tool_result" + TAG_R

private const val DOWNGRADE_RE =
    "tools|function calling|tool[_ -]?calls|not supported|unsupported"

class AgentToolRunner(
    private val onToken: (String) -> Unit,
    private val onReasoning: (String) -> Unit,
    private val onToolEvent: (ToolEvent) -> Unit
) {

    data class ProviderCfg(
        val baseUrl: String,
        val model: String,
        val apiKey: String,
        val temperature: Double
    )

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    private var executedTools = false

    private data class MutableSlot(var id: String, var name: String, var args: String)

    fun providerCfg(): ProviderCfg {
        val s = CmgSettings.getInstance().state
        val baseUrl = if (s.baseUrl.isBlank()) {
            when (s.provider) {
                "qwen" -> "https://dashscope.aliyuncs.com/compatible-mode/v1"
                "openai" -> "https://api.openai.com/v1"
                else -> "https://api.deepseek.com"
            }
        } else s.baseUrl.trim()
        val model = if (s.modelName.isBlank()) {
            when (s.provider) {
                "qwen" -> "qwen-plus"
                "openai" -> "gpt-4o-mini"
                else -> "deepseek-chat"
            }
        } else s.modelName.trim()
        return ProviderCfg(
            baseUrl = baseUrl,
            model = model,
            apiKey = CmgSettings.getInstance().apiKey,
            temperature = s.temperature
        )
    }

    fun streamCall(
        cfg: ProviderCfg,
        messages: List<ChatMessage>,
        tools: List<AgentTool>,
        isStopped: () -> Boolean
    ): Pair<String, List<ToolCallSpec>> {
        val url = cfg.baseUrl.trimEnd('/').let { if (it.endsWith("/v1")) it else "$it/v1" } + "/chat/completions"

        val body = JSONObject()
        body.put("model", cfg.model)
        val arr = JSONArray()
        for (m in messages) arr.put(m.toJson())
        body.put("messages", arr)
        body.put("temperature", cfg.temperature.coerceIn(0.0, 2.0))
        body.put("stream", true)
        if (tools.isNotEmpty()) {
            val toolArr = JSONArray()
            for (t in tools) {
                toolArr.put(JSONObject().apply {
                    put("type", "function")
                    put("function", JSONObject().apply {
                        put("name", t.name)
                        put("description", t.description)
                        put("parameters", JSONObject(t.parametersJson))
                    })
                })
            }
            body.put("tools", toolArr)
        }

        val request = Request.Builder()
            .url(url)
            .addHeader("Content-Type", "application/json")
            .addHeader("Authorization", "Bearer ${cfg.apiKey}")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()

        val response = client.newCall(request).execute()
        if (!response.isSuccessful) {
            val err = (response.body?.string() ?: response.message).take(300)
            response.close()
            throw RuntimeException("Chat API error ${response.code}: $err")
        }

        val fullText = StringBuilder()
        val toolAccum = linkedMapOf<Int, MutableSlot>()

        val b = response.body ?: throw RuntimeException("Chat API error: empty body")
        val source: BufferedSource = b.source()
        val eventLines = mutableListOf<String>()
        while (true) {
            if (isStopped()) throw RuntimeException("Stopped by user")
            val line = source.readUtf8Line() ?: break
            if (line.isEmpty()) {
                if (eventLines.isNotEmpty()) {
                    for (l in eventLines) processLine(l, fullText, toolAccum)
                    eventLines.clear()
                }
            } else {
                eventLines.add(line)
            }
        }
        if (eventLines.isNotEmpty()) {
            for (l in eventLines) processLine(l, fullText, toolAccum)
        }
        source.close()
        response.close()

        val calls = toolAccum.values.map { ToolCallSpec(it.id.ifBlank { "call_${it.name}" }, it.name, it.args) }
        return fullText.toString() to calls
    }

    private fun processLine(
        line: String,
        fullText: StringBuilder,
        toolAccum: MutableMap<Int, MutableSlot>
    ) {
        if (!line.startsWith("data:")) return
        val data = line.removePrefix("data:").trim()
        if (data == "[DONE]") return
        try {
            val parsed = JSONObject(data)
            val choice = parsed.optJSONArray("choices")?.optJSONObject(0) ?: return
            val delta = choice.optJSONObject("delta") ?: return
            val reasoning = delta.optString("reasoning_content", "")
            if (reasoning.isNotEmpty()) onReasoning(reasoning)
            val content = delta.optString("content", "")
            if (content.isNotEmpty()) {
                fullText.append(content)
                onToken(content)
            }
            val tcs = delta.optJSONArray("tool_calls")
            if (tcs != null) {
                for (i in 0 until tcs.length()) {
                    val tc = tcs.optJSONObject(i) ?: continue
                    val idx = tc.optInt("index", -1)
                    if (idx < 0) continue
                    val slot = toolAccum.getOrPut(idx) { MutableSlot("", "", "") }
                    val id = tc.optString("id", "")
                    if (id.isNotEmpty()) slot.id = id
                    val fn = tc.optJSONObject("function")
                    if (fn != null) {
                        val nm = fn.optString("name", "")
                        if (nm.isNotEmpty()) slot.name = nm
                        val arg = fn.optString("arguments", "")
                        if (arg.isNotEmpty()) slot.args += arg
                    }
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun buildApprovalDetail(name: String, args: JSONObject): String = when (name) {
        "write_file" -> {
            val content = args.optString("content", "")
            val head = if (content.length > 500) content.take(500) + "\n..." else content
            "File: ${args.optString("path", "")}\n\n$head"
        }
        "edit_file" -> "File: ${args.optString("path", "")}\n--- replace ---\n${args.optString("oldText", "")}\n+++ with +++\n${args.optString("newText", "")}"
        "run_command" -> args.optString("command", "")
        "git_commit" -> args.optString("message", "")
        else -> args.toString().take(500)
    }

    fun executeToolCall(tool: AgentTool, call: ToolCallSpec, ctx: ToolContext): ToolResult {
        val argsJson = try {
            JSONObject(call.arguments.ifBlank { "{}" })
        } catch (_: Exception) {
            JSONObject()
        }
        val needs = tool.needsApproval(ctx, argsJson)
        if (needs) {
            val summary = "执行工具 ${tool.name}"
            val detail = buildApprovalDetail(tool.name, argsJson)
            onToolEvent(ToolEvent.Approval(tool.name, summary))
            val ok = ctx.confirm(summary, detail)
            if (!ok) {
                onToolEvent(ToolEvent.Result(tool.name, false, "User declined to run ${tool.name}."))
                return ToolResult(false, "User declined to run ${tool.name}.")
            }
        }
        onToolEvent(ToolEvent.Start(tool.name, argsJson))
        val result = tool.execute(ctx, argsJson)
        onToolEvent(ToolEvent.Result(tool.name, result.ok, truncateToolResult(result.content, 4000)))
        return result
    }

    private fun parseFallbackToolCalls(text: String): List<Pair<String, JSONObject>> {
        val pattern = TOOL_CALL_OPEN +
            "\\s*(\\{[\\s\\S]*?\\})\\s*" + TOOL_CALL_CLOSE
        val regex = Regex(pattern)
        val result = mutableListOf<Pair<String, JSONObject>>()
        regex.findAll(text).forEach { m ->
            try {
                val obj = JSONObject(m.groupValues[1])
                val name = obj.optString("name", "")
                if (name.isNotEmpty()) {
                    val args = obj.optJSONObject("arguments") ?: JSONObject()
                    result.add(name to args)
                }
            } catch (_: Exception) {
            }
        }
        return result
    }

    private fun buildFallbackSystem(originalSystem: String, tools: List<AgentTool>): String {
        val toolDescs = tools.joinToString("\n") { t ->
            "- ${t.name}: ${t.description}\n  arguments schema: ${t.parametersJson}"
        }
        val open = TOOL_CALL_OPEN
        val close = TOOL_CALL_CLOSE
        return "$originalSystem\n\nYou may call tools when needed. To call a tool, output EXACTLY one line with a JSON block:\n$open\n{\"name\":\"<tool_name>\",\"arguments\":{...}}\n$close\n\nThen the tool result will be provided to you. Wait for the result before continuing. You must NOT fabricate tool results.\n\nAvailable tools:\n$toolDescs"
    }

    private fun nativeLoop(
        cfg: ProviderCfg,
        messages: List<ChatMessage>,
        tools: List<AgentTool>,
        ctx: ToolContext,
        isStopped: () -> Boolean
    ): String {
        val msgs = messages.toMutableList()
        for (round in 0 until MAX_TOOL_ROUNDS) {
            if (isStopped()) throw RuntimeException("Stopped by user")
            val (text, calls) = streamCall(cfg, msgs, tools, isStopped)
            if (calls.isEmpty()) return text
            msgs.add(ChatMessage("assistant", text, toolCalls = calls))
            for (call in calls) {
                val tool = ToolRegistry.get(call.name)
                executedTools = true
                val outcome = if (tool != null) {
                    executeToolCall(tool, call, ctx)
                } else {
                    ToolResult(false, "Unknown tool: ${call.name}")
                }
                msgs.add(ChatMessage("tool", truncateToolResult(outcome.content, 4000), toolCallId = call.id))
            }
        }
        throw RuntimeException("Tool call limit reached ($MAX_TOOL_ROUNDS rounds)")
    }

    private fun fallbackLoop(
        cfg: ProviderCfg,
        messages: List<ChatMessage>,
        tools: List<AgentTool>,
        ctx: ToolContext,
        isStopped: () -> Boolean
    ): String {
        var msgs = messages.mapIndexed { i, m ->
            if (i == 0 && m.role == "system") ChatMessage("system", buildFallbackSystem(m.content, tools)) else m
        }.toMutableList()
        for (round in 0 until MAX_TOOL_ROUNDS) {
            if (isStopped()) throw RuntimeException("Stopped by user")
            val (text, _) = streamCall(cfg, msgs, emptyList(), isStopped)
            val calls = parseFallbackToolCalls(text)
            if (calls.isEmpty()) return text
            var acc = text
            for ((name, args) in calls) {
                val tool = ToolRegistry.get(name)
                val call = ToolCallSpec("", name, args.toString())
                val outcome = if (tool != null) {
                    executeToolCall(tool, call, ctx)
                } else {
                    ToolResult(false, "Unknown tool: $name")
                }
                acc += "\n" + TOOL_RESULT_OPEN + " name=\"$name\">\n" +
                    truncateToolResult(outcome.content, 4000) + "\n" + TOOL_RESULT_CLOSE
            }
            msgs.add(ChatMessage("assistant", text))
            msgs.add(ChatMessage("user", "Tool results:\n$acc"))
        }
        throw RuntimeException("Tool call limit reached ($MAX_TOOL_ROUNDS rounds)")
    }

    fun run(
        messages: List<ChatMessage>,
        tools: List<AgentTool>,
        workspaceRoot: String,
        project: Project,
        confirm: (summary: String, detail: String?) -> Boolean,
        isStopped: () -> Boolean,
        nativeTools: Boolean
    ): String {
        val cfg = providerCfg()
        val ctx = ToolContext(project, workspaceRoot, confirm, isStopped)
        executedTools = false
        val effectiveTools = if (tools.isNotEmpty()) tools else ToolRegistry.list()

        if (!nativeTools) {
            return fallbackLoop(cfg, messages, effectiveTools, ctx, isStopped)
        }
        return try {
            nativeLoop(cfg, messages, effectiveTools, ctx, isStopped)
        } catch (e: Exception) {
            val msg = e.message ?: e.toString()
            val downgradeRe = Regex(DOWNGRADE_RE, RegexOption.IGNORE_CASE)
            if (!executedTools && downgradeRe.containsMatchIn(msg)) {
                fallbackLoop(cfg, messages, effectiveTools, ctx, isStopped)
            } else {
                throw e
            }
        }
    }

    companion object {
        const val MAX_TOOL_ROUNDS = 15
    }
}
