package com.bluecome.cmg.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.ui.components.JBTextField
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.*

class CmgSettingsConfigurable : Configurable {

    private val apiKeyField = JBPasswordField()
    private val providerBox = JComboBox(arrayOf("deepseek", "qwen", "openai"))
    private val baseUrlField = JBTextField()
    private val modelNameField = JBTextField()
    private val apiEndpointField = JBTextField()
    private val prefixModeBox = JComboBox(arrayOf("standard", "custom"))
    private val standardPrefixField = JBTextField()
    private val customPrefixField = JBTextField()
    private val suggestionCountSpinner = JSpinner(SpinnerNumberModel(5, 2, 10, 1))
    private val temperatureSpinner = JSpinner(SpinnerNumberModel(0.7, 0.0, 1.0, 0.1))
    private val maxTokensSpinner = JSpinner(SpinnerNumberModel(200, 50, 4000, 50))
    private val languageBox = JComboBox(arrayOf("auto", "zh", "en", "ja", "ru", "fr", "de"))
    private val uiLanguageBox = JComboBox(arrayOf("auto", "zh", "en", "ja", "ru", "fr", "de"))
    private val accordingHistoryBox = JBCheckBox("Reference recent commit history style")

    override fun getDisplayName() = "HisCCS"

    override fun createComponent(): JComponent {
        val panel = JPanel(GridBagLayout())
        val gbc = GridBagConstraints().apply {
            fill = GridBagConstraints.HORIZONTAL
            insets = Insets(4, 4, 4, 4)
        }

        fun row(label: String, comp: JComponent, row: Int) {
            gbc.gridx = 0; gbc.gridy = row; gbc.weightx = 0.0
            panel.add(JBLabel("$label:"), gbc)
            gbc.gridx = 1; gbc.weightx = 1.0
            panel.add(comp, gbc)
        }

        row("API Key",                    apiKeyField,            0)
        row("Provider",                   providerBox,            1)
        row("Base URL (optional)",        baseUrlField,           2)
        row("Model Name (optional)",      modelNameField,         3)
        row("Backend Endpoint (optional)", apiEndpointField,      4)
        row("Prefix Mode",                prefixModeBox,          5)
        row("Standard Prefix",            standardPrefixField,    6)
        row("Custom Prefix",              customPrefixField,      7)
        row("Suggestion Count",           suggestionCountSpinner, 8)
        row("Temperature",                temperatureSpinner,     9)
        row("Max Tokens",                 maxTokensSpinner,       10)
        row("Commit Language",            languageBox,            11)
        row("UI Language",                uiLanguageBox,          12)

        gbc.gridx = 0; gbc.gridy = 13; gbc.gridwidth = 2; gbc.weightx = 1.0
        panel.add(accordingHistoryBox, gbc)

        // filler
        gbc.gridx = 0; gbc.gridy = 14; gbc.weighty = 1.0
        panel.add(JPanel(), gbc)

        return panel
    }

    override fun isModified(): Boolean {
        val settings = CmgSettings.getInstance()
        val s = settings.state
        return String(apiKeyField.password) != settings.apiKey ||
            providerBox.selectedItem != s.provider ||
            baseUrlField.text != s.baseUrl ||
            modelNameField.text != s.modelName ||
            apiEndpointField.text != s.apiEndpoint ||
            prefixModeBox.selectedItem != s.prefixMode ||
            standardPrefixField.text != s.standardPrefix ||
            customPrefixField.text != s.customPrefix ||
            (suggestionCountSpinner.value as Int) != s.suggestionCount ||
            (temperatureSpinner.value as Double) != s.temperature ||
            (maxTokensSpinner.value as Int) != s.maxTokens ||
            languageBox.selectedItem != s.language ||
            uiLanguageBox.selectedItem != s.uiLanguage ||
            accordingHistoryBox.isSelected != s.accordingHistory
    }

    override fun apply() {
        val settings = CmgSettings.getInstance()
        val s = settings.state
        settings.apiKey = String(apiKeyField.password).trim()
        s.provider = providerBox.selectedItem as String
        s.baseUrl = baseUrlField.text.trim()
        s.modelName = modelNameField.text.trim()
        s.apiEndpoint = apiEndpointField.text.trim()
        s.prefixMode = prefixModeBox.selectedItem as String
        s.standardPrefix = standardPrefixField.text.trim()
        s.customPrefix = customPrefixField.text.trim()
        s.suggestionCount = suggestionCountSpinner.value as Int
        s.temperature = temperatureSpinner.value as Double
        s.maxTokens = maxTokensSpinner.value as Int
        s.language = languageBox.selectedItem as String
        s.uiLanguage = uiLanguageBox.selectedItem as String
        s.accordingHistory = accordingHistoryBox.isSelected
    }

    override fun reset() {
        val settings = CmgSettings.getInstance()
        val s = settings.state
        apiKeyField.text = settings.apiKey
        providerBox.selectedItem = s.provider
        baseUrlField.text = s.baseUrl
        modelNameField.text = s.modelName
        apiEndpointField.text = s.apiEndpoint
        prefixModeBox.selectedItem = s.prefixMode
        standardPrefixField.text = s.standardPrefix
        customPrefixField.text = s.customPrefix
        suggestionCountSpinner.value = s.suggestionCount
        temperatureSpinner.value = s.temperature
        maxTokensSpinner.value = s.maxTokens
        languageBox.selectedItem = s.language
        uiLanguageBox.selectedItem = s.uiLanguage
        accordingHistoryBox.isSelected = s.accordingHistory
    }
}
