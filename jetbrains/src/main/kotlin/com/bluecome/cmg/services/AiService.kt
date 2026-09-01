package com.bluecome.cmg.services

import com.bluecome.cmg.settings.CmgSettings
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object AiService {

    private val PROVIDER_BASE_URLS = mapOf(
        "deepseek" to "https://api.deepseek.com",
        "qwen"     to "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "openai"   to "https://api.openai.com/v1"
    )

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

    /**
     * Generate commit message candidates with retrieval-augmented prompting.
     *
     * Flow: diff + history → RetrievalService (BM25) → similar commits
     *       → PromptBuilder (augmented with similar examples) → AI API → candidates
     */
    fun generate(diff: String, history: List<String>, allCommits: List<String>, s: CmgSettings.State, apiKey: String): List<String> {
        // Retrieval-augmented: find similar historical commits via BM25
        val similarCommits = RetrievalService.retrieveSimilarCommits(allCommits, diff, topK = 5)
        val similarMsgs = similarCommits.map { it.first }

        val (system, user) = PromptBuilder.build(
            diff, history, similarMsgs, s.suggestionCount,
            s.prefixMode, s.standardPrefix, s.customPrefix, s.language
        )
        return if (s.apiEndpoint.isNotBlank()) {
            callProxy(s, diff, history, similarMsgs)
        } else {
            callDirect(s, apiKey, system, user)
        }
    }

    private fun callProxy(s: CmgSettings.State, diff: String, history: List<String>, similarCommits: List<String>): List<String> {
        val lang = PromptBuilder.resolveLanguage(s.language)
        val body = JSONObject().apply {
            put("diff", diff)
            put("needRec", if (s.suggestionCount > 1) 1 else 0)
            put("temperature", s.temperature)
            put("max_tokens", s.maxTokens)
            put("language", lang)
            if (history.isNotEmpty()) put("historyMessage", JSONArray(history))
            if (similarCommits.isNotEmpty()) put("similarCommits", JSONArray(similarCommits))
        }
        val req = Request.Builder()
            .url("${s.apiEndpoint.trimEnd('/')}/cmg")
            .post(body.toString().toRequestBody(JSON_MEDIA))
            .build()
        val resp = client.newCall(req).execute()
        val text = resp.body?.string().orEmpty()
        if (!resp.isSuccessful) throw RuntimeException("HTTP ${resp.code}: ${text.take(200)}")
        val json = JSONObject(text)
        val arr = json.optJSONArray("commit_message") ?: return listOf("chore: update code")
        return (0 until arr.length()).map { arr.getString(it) }.filter { it.isNotBlank() }
            .ifEmpty { listOf("chore: update code") }
    }

    private fun callDirect(s: CmgSettings.State, apiKey: String, system: String, user: String): List<String> {
        val baseUrl = s.baseUrl.ifBlank { PROVIDER_BASE_URLS[s.provider] ?: "https://api.deepseek.com" }
        val model = s.modelName.ifBlank {
            when (s.provider) {
                "qwen"   -> "qwen-plus"
                "openai" -> "gpt-4o-mini"
                else     -> "deepseek-chat"
            }
        }
        val messages = JSONArray().apply {
            put(JSONObject().put("role", "system").put("content", system))
            put(JSONObject().put("role", "user").put("content", user))
        }
        val body = JSONObject().apply {
            put("model", model)
            put("messages", messages)
            put("temperature", s.temperature)
            put("max_tokens", s.maxTokens)
        }
        val url = "${baseUrl.trimEnd('/')}/chat/completions"
        val req = Request.Builder()
            .url(url)
            .addHeader("Authorization", "Bearer $apiKey")
            .post(body.toString().toRequestBody(JSON_MEDIA))
            .build()
        val resp = client.newCall(req).execute()
        val text = resp.body?.string().orEmpty()
        if (!resp.isSuccessful) throw RuntimeException("HTTP ${resp.code} $url — ${text.take(200)}")
        val json = JSONObject(text)

        // Check for API-level errors and surface them clearly
        val errorMsg = json.optJSONObject("error")?.optString("message")
        if (!errorMsg.isNullOrBlank()) throw RuntimeException(errorMsg!!)

        val choices = json.optJSONArray("choices") ?: return listOf("chore: update code")

        // Collect all content from choices and parse numbered lines robustly
        val rawContents = (0 until choices.length())
            .mapNotNull { choices.getJSONObject(it).optJSONObject("message")?.optString("content") }

        return parseCommitCandidates(rawContents, s.suggestionCount)
    }

    /**
     * Parses commit candidates from one or more raw content strings.
     * Accepts both numbered-list format ("1. feat: ...") and plain single-line format.
     */
    internal fun parseCommitCandidates(contents: List<String>, expected: Int): List<String> {
        // First pass: try numbered list across all content blocks
        val numbered = contents.flatMap { content ->
            content.lines()
                .filter { it.matches(Regex("""^\d+[.)]\s*.+""")) }
                .map { it.replace(Regex("""^\d+[.)]\s*"""), "").trim() }
        }.filter { it.isNotBlank() }
        if (numbered.isNotEmpty()) return numbered

        // Second pass: each choice is one plain commit message (single-choice or non-standard format)
        val plain = contents.map { it.trim() }.filter { it.isNotBlank() }
        if (plain.isNotEmpty()) return plain

        return listOf("chore: update code")
    }

    /**
     * Generate completion candidates with retrieval-augmented prompting.
     */
    fun generateCompletion(diff: String, history: List<String>, allCommits: List<String>, userInput: String, s: CmgSettings.State, apiKey: String): List<String> {
        // Retrieval-augmented: find similar historical commits
        val similarCommits = RetrievalService.retrieveSimilarCommits(allCommits, diff, topK = 5)
        val similarMsgs = similarCommits.map { it.first }

        val lang = PromptBuilder.resolveLanguage(s.language)
        val (system, user) = PromptBuilder.buildCompletion(diff, history, similarMsgs, userInput, lang)

        if (s.apiEndpoint.isNotBlank()) {
            val body = JSONObject().apply {
                put("diff", diff)
                put("userInput", userInput)
                put("needRec", 0)
                put("temperature", s.temperature)
                put("max_tokens", s.maxTokens)
                put("language", lang)
                if (history.isNotEmpty()) put("historyMessage", JSONArray(history))
                if (similarMsgs.isNotEmpty()) put("similarCommits", JSONArray(similarMsgs))
            }
            val req = Request.Builder()
                .url("${s.apiEndpoint.trimEnd('/')}/cmg")
                .post(body.toString().toRequestBody(JSON_MEDIA))
                .build()
            val resp = client.newCall(req).execute()
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw RuntimeException("HTTP ${resp.code}: ${text.take(200)}")
            val arr = JSONObject(text).optJSONArray("commit_message")
            return (0 until (arr?.length() ?: 0)).map { arr!!.getString(it) }.filter { it.isNotBlank() }.ifEmpty { listOf("chore: update code") }
        }
        return callDirect(s, apiKey, system, user)
    }
}
