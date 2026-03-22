package com.claudeway.settings

import android.content.Context
import androidx.core.content.edit

data class ConnectionSettings(
    val serverUrl: String = "",
    val authToken: String = "",
) {
    val hasCredentials: Boolean
        get() = serverUrl.isNotBlank() && authToken.isNotBlank()
}

class ConnectionSettingsRepository(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun load(): ConnectionSettings = ConnectionSettings(
        serverUrl = prefs.getString(KEY_SERVER_URL, "") ?: "",
        authToken = prefs.getString(KEY_AUTH_TOKEN, "") ?: "",
    )

    fun save(serverUrl: String, authToken: String) {
        prefs.edit {
            putString(KEY_SERVER_URL, serverUrl)
            putString(KEY_AUTH_TOKEN, authToken)
        }
    }

    companion object {
        private const val PREFS_NAME = "claudeway"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_AUTH_TOKEN = "auth_token"
    }
}
