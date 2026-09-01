package com.bluecome.cmg.settings

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

@State(name = "CmgSettings", storages = [Storage("BlueCome.xml")])
@Service(Service.Level.APP)
class CmgSettings : PersistentStateComponent<CmgSettings.State> {

    data class State(
        var provider: String = "deepseek",
        var baseUrl: String = "",
        var modelName: String = "",
        var apiEndpoint: String = "",
        var prefixMode: String = "standard",
        var standardPrefix: String = "",
        var customPrefix: String = "",
        var suggestionCount: Int = 5,
        var temperature: Double = 0.7,
        var maxTokens: Int = 200,
        var language: String = "auto",
        var uiLanguage: String = "auto",
        var accordingHistory: Boolean = false
    )

    private var myState = State()

    override fun getState(): State = myState

    override fun loadState(state: State) {
        myState = state
    }

    /** API key stored in OS credential store via PasswordSafe, not in plain XML. */
    var apiKey: String
        get() {
            val attrs = CredentialAttributes("BlueCome.CMG", "apiKey")
            return PasswordSafe.instance.getPassword(attrs) ?: ""
        }
        set(value) {
            val attrs = CredentialAttributes("BlueCome.CMG", "apiKey")
            PasswordSafe.instance.set(attrs, if (value.isBlank()) null else Credentials("apiKey", value))
        }

    companion object {
        fun getInstance(): CmgSettings =
            ApplicationManager.getApplication().getService(CmgSettings::class.java)
    }
}
