package com.bluecome.cmg.toolwindow

import com.bluecome.cmg.I18n
import com.bluecome.cmg.settings.CmgSettings
import com.intellij.openapi.application.ApplicationManager
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTextField
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.awt.Color
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import java.util.concurrent.TimeUnit
import javax.swing.*
import javax.swing.border.EmptyBorder

class SettingsPanel : JPanel(GridBagLayout()) {

    private val apiKeyField = JBPasswordField()
    private val providerBox = JComboBox(arrayOf("deepseek", "qwen", "openai"))
    private val baseUrlField = JBTextField()
    private val modelBox = JComboBox<String>().apply { isEditable = true }
    private val apiEndpointField = JBTextField()
    private val prefixModeBox = JComboBox(arrayOf("standard", "custom"))
    private val standardPrefixBox = JComboBox(arrayOf(
        "", "feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "revert", "ci", "build"
    )).apply { isEditable = true }
    private val customPrefixField = JBTextField()
    private val suggestionCountSpinner = JSpinner(SpinnerNumberModel(5, 2, 10, 1))
    private val temperatureSpinner = JSpinner(SpinnerNumberModel(0.7, 0.0, 1.0, 0.1))
    private val maxTokensSpinner = JSpinner(SpinnerNumberModel(200, 50, 4000, 50))
    private val languageBox = JComboBox(arrayOf("auto", "zh", "en", "ja", "ru", "fr", "de"))
    private val uiLanguageBox = JComboBox(arrayOf("auto", "zh", "en", "ja", "ru", "fr", "de"))
    private val accordingHistoryBox = JBCheckBox()
    private val saveBtn = JButton()
    private val fetchModelsBtn = JButton()
    private val testSpeedBtn = JButton()
    private val statusLabel = JBLabel(" ")
    private val apiStatusDot = JLabel("●").apply { font = font.deriveFont(10f) }
    private val apiStatusText = JLabel()

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private fun t(key: String) = I18n.t(CmgSettings.getInstance().state.uiLanguage, key)

    init {
        buildUi()
        reset()
    }

    private fun buildUi() {
        val gbc = GridBagConstraints().apply {
            fill = GridBagConstraints.HORIZONTAL; insets = Insets(3, 4, 3, 4)
        }

        // API status indicator row
        val apiStatusPanel = JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 6, 4)).apply {
            isOpaque = true
            background = UIManager.getColor("Panel.background") ?: Color(245, 245, 245)
            border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(UIManager.getColor("Component.borderColor") ?: Color(200, 200, 200)),
                EmptyBorder(2, 6, 2, 6)
            )
            apiStatusText.font = apiStatusText.font.deriveFont(12f)
            add(apiStatusDot); add(apiStatusText)
        }
        gbc.gridx = 0; gbc.gridy = 0; gbc.gridwidth = 2; gbc.weightx = 1.0
        gbc.insets = Insets(6, 4, 8, 4)
        add(apiStatusPanel, gbc)
        gbc.insets = Insets(3, 4, 3, 4)

        fun row(label: String, comp: JComponent, row: Int, wide: Boolean = false) {
            gbc.gridx = 0; gbc.gridy = row; gbc.weightx = 0.0; gbc.gridwidth = 1
            add(JBLabel("$label:"), gbc)
            gbc.gridx = 1; gbc.weightx = 1.0; gbc.gridwidth = if (wide) 2 else 1
            add(comp, gbc)
        }

        row(t("labelApiKey"),          apiKeyField,            1)
        row(t("labelProvider"),        providerBox,            2)
        row(t("labelBaseUrl"),         baseUrlField,           3)

        // Model row with fetch button
        val modelPanel = JPanel(java.awt.BorderLayout(4, 0)).apply {
            add(modelBox, java.awt.BorderLayout.CENTER)
            fetchModelsBtn.text = t("btnFetchModels")
            add(fetchModelsBtn, java.awt.BorderLayout.EAST)
        }
        row(t("labelModelName"),       modelPanel,             4)

        row(t("labelApiEndpoint"),     apiEndpointField,       5)
        row(t("labelPrefixMode"),      prefixModeBox,          6)
        row(t("labelStandardPrefix"),  standardPrefixBox,      7)
        row(t("labelCustomPrefix"),    customPrefixField,      8)
        row(t("labelSuggestionCount"), suggestionCountSpinner, 9)
        row(t("labelTemperature"),     temperatureSpinner,     10)
        row(t("labelMaxTokens"),       maxTokensSpinner,       11)
        row(t("labelLanguage"),        languageBox,            12)
        row(t("labelUiLanguage"),      uiLanguageBox,          13)

        accordingHistoryBox.text = t("labelAccordingHistory")
        gbc.gridx = 0; gbc.gridy = 14; gbc.gridwidth = 2; gbc.weightx = 1.0
        add(accordingHistoryBox, gbc)

        saveBtn.text = t("btnSaveSettings")
        testSpeedBtn.text = t("btnTestSpeed")
        saveBtn.addActionListener {
            apply()
            updateApiStatus()
        }
        testSpeedBtn.addActionListener { testSpeed() }
        fetchModelsBtn.addActionListener { fetchModels() }

        val btnRow = JPanel().apply { add(testSpeedBtn); add(saveBtn) }
        gbc.gridx = 0; gbc.gridy = 15; gbc.gridwidth = 2
        add(btnRow, gbc)

        gbc.gridx = 0; gbc.gridy = 16; gbc.gridwidth = 2
        add(statusLabel, gbc)

        gbc.gridx = 0; gbc.gridy = 17; gbc.weighty = 1.0
        add(JPanel(), gbc)
    }

    private fun updateApiStatus() {
        val settings = CmgSettings.getInstance()
        // Check both PasswordSafe and the input field content
        val savedKey = settings.apiKey
        val fieldPassword = String(apiKeyField.password).trim()
        val hasKey = savedKey.isNotBlank() || fieldPassword.isNotBlank() || settings.state.apiEndpoint.isNotBlank()
        apiStatusDot.foreground = if (hasKey) Color(46, 160, 67) else Color(218, 54, 51)
        apiStatusText.text = if (hasKey) "API Key 已配置" else "未配置 API Key"
        apiStatusText.foreground = if (hasKey) Color(46, 160, 67) else Color(218, 54, 51)
    }

    fun reset() {
        val s = CmgSettings.getInstance()
        val st = s.state
        apiKeyField.text = s.apiKey
        providerBox.selectedItem = st.provider
        baseUrlField.text = st.baseUrl
        modelBox.removeAllItems()
        if (st.modelName.isNotBlank()) { modelBox.addItem(st.modelName); modelBox.selectedItem = st.modelName }
        apiEndpointField.text = st.apiEndpoint
        prefixModeBox.selectedItem = st.prefixMode
        standardPrefixBox.selectedItem = st.standardPrefix
        customPrefixField.text = st.customPrefix
        suggestionCountSpinner.value = st.suggestionCount
        temperatureSpinner.value = st.temperature
        maxTokensSpinner.value = st.maxTokens
        languageBox.selectedItem = st.language
        uiLanguageBox.selectedItem = st.uiLanguage
        accordingHistoryBox.isSelected = st.accordingHistory
        statusLabel.text = " "
        updateApiStatus()
    }

    private fun apply() {
        val s = CmgSettings.getInstance(); val st = s.state
        s.apiKey = String(apiKeyField.password).trim()
        st.provider = providerBox.selectedItem as String
        st.baseUrl = baseUrlField.text.trim()
        st.modelName = (modelBox.selectedItem as? String).orEmpty().trim()
        st.apiEndpoint = apiEndpointField.text.trim()
        st.prefixMode = prefixModeBox.selectedItem as String
        st.standardPrefix = (standardPrefixBox.selectedItem as? String).orEmpty().trim()
        st.customPrefix = customPrefixField.text.trim()
        st.suggestionCount = suggestionCountSpinner.value as Int
        st.temperature = temperatureSpinner.value as Double
        st.maxTokens = maxTokensSpinner.value as Int
        st.language = languageBox.selectedItem as String
        st.uiLanguage = uiLanguageBox.selectedItem as String
        st.accordingHistory = accordingHistoryBox.isSelected
        statusLabel.text = t("msgSettingsSaved")
    }

    private fun fetchModels() {
        statusLabel.text = t("loadingFetchingModels")
        fetchModelsBtn.isEnabled = false
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val s = CmgSettings.getInstance().state
                val apiKey = CmgSettings.getInstance().apiKey
                val baseUrl = resolveBaseUrl(s)
                val req = Request.Builder()
                    .url("${baseUrl.trimEnd('/')}/models")
                    .addHeader("Authorization", "Bearer $apiKey")
                    .get().build()
                val resp = httpClient.newCall(req).execute()
                val body = resp.body?.string().orEmpty()
                val models = JSONObject(body).optJSONArray("data")
                val ids = (0 until (models?.length() ?: 0)).map { models!!.getJSONObject(it).optString("id") }.filter { it.isNotBlank() }.sorted()
                SwingUtilities.invokeLater {
                    val current = (modelBox.selectedItem as? String).orEmpty()
                    modelBox.removeAllItems()
                    ids.forEach { modelBox.addItem(it) }
                    if (current.isNotBlank()) modelBox.selectedItem = current
                    statusLabel.text = t("doneModelsFetched").replace("{0}", ids.size.toString())
                    fetchModelsBtn.isEnabled = true
                }
            } catch (ex: Exception) {
                SwingUtilities.invokeLater {
                    statusLabel.text = "Error: ${ex.message?.take(60)}"
                    fetchModelsBtn.isEnabled = true
                }
            }
        }
    }

    private fun testSpeed() {
        statusLabel.text = t("loadingTestingSpeed")
        testSpeedBtn.isEnabled = false
        ApplicationManager.getApplication().executeOnPooledThread {
            val start = System.currentTimeMillis()
            try {
                val s = CmgSettings.getInstance().state
                val apiKey = CmgSettings.getInstance().apiKey
                val baseUrl = resolveBaseUrl(s)
                val model = (modelBox.selectedItem as? String)?.ifBlank { null } ?: resolveDefaultModel(s)
                val body = JSONObject().apply {
                    put("model", model)
                    put("messages", org.json.JSONArray().put(JSONObject().put("role","user").put("content","hi")))
                    put("max_tokens", 1)
                }
                val req = Request.Builder()
                    .url("${baseUrl.trimEnd('/')}/chat/completions")
                    .addHeader("Authorization", "Bearer $apiKey")
                    .post(body.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
                    .build()
                val resp = httpClient.newCall(req).execute()
                val elapsed = System.currentTimeMillis() - start
                SwingUtilities.invokeLater {
                    statusLabel.text = t("doneSpeedResult").replace("{0}", resp.code.toString()).replace("{1}", elapsed.toString())
                    testSpeedBtn.isEnabled = true
                }
            } catch (ex: Exception) {
                val elapsed = System.currentTimeMillis() - start
                SwingUtilities.invokeLater {
                    statusLabel.text = t("doneSpeedFailed").replace("{0}", ex.message?.take(50) ?: "")
                    testSpeedBtn.isEnabled = true
                }
            }
        }
    }

    private fun resolveBaseUrl(s: CmgSettings.State) = s.baseUrl.ifBlank {
        when (s.provider) { "qwen" -> "https://dashscope.aliyuncs.com/compatible-mode/v1"; "openai" -> "https://api.openai.com/v1"; else -> "https://api.deepseek.com" }
    }

    private fun resolveDefaultModel(s: CmgSettings.State) = when (s.provider) { "qwen" -> "qwen-plus"; "openai" -> "gpt-4o-mini"; else -> "deepseek-chat" }
}
