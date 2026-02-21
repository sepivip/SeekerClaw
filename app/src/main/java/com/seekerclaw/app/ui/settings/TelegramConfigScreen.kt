package com.seekerclaw.app.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TelegramConfigScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var config by remember { mutableStateOf(ConfigManager.loadConfig(context)) }

    var editField by remember { mutableStateOf<String?>(null) }
    var editLabel by remember { mutableStateOf("") }
    var editValue by remember { mutableStateOf("") }

    var testStatus by remember { mutableStateOf("Idle") } // Idle, Loading, Success, Error
    var testMessage by remember { mutableStateOf("") }

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    fun saveField(field: String, value: String) {
        ConfigManager.updateConfigField(context, field, value)
        config = ConfigManager.loadConfig(context)
    }

    val maskedBotToken = config?.telegramBotToken?.let { token ->
        if (token.isBlank()) "Not set"
        else if (token.length > 20) "${token.take(8)}${"*".repeat(8)}${token.takeLast(4)}" else "*".repeat(token.length)
    } ?: "Not set"

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "Telegram Configuration",
                        fontFamily = RethinkSans,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.TextPrimary
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                            tint = SeekerClawColors.TextPrimary
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = SeekerClawColors.Background
                )
            )
        },
        containerColor = SeekerClawColors.Background
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 20.dp, vertical = 8.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape),
            ) {
                ProviderConfigField(
                    label = "Bot Token",
                    value = maskedBotToken,
                    onClick = {
                        editField = "telegramBotToken"
                        editLabel = "Bot Token"
                        editValue = config?.telegramBotToken ?: ""
                    },
                    info = SettingsHelpTexts.BOT_TOKEN,
                    isRequired = true,
                )
                ProviderConfigField(
                    label = "Owner ID",
                    value = config?.telegramOwnerId?.ifBlank { "Auto-detect" } ?: "Auto-detect",
                    onClick = {
                        editField = "telegramOwnerId"
                        editLabel = "Owner ID"
                        editValue = config?.telegramOwnerId ?: ""
                    },
                    info = SettingsHelpTexts.OWNER_ID,
                    showDivider = false
                )
            }

            Spacer(modifier = Modifier.height(28.dp))
            ProviderSectionLabel("Connection Test")
            Spacer(modifier = Modifier.height(10.dp))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SeekerClawColors.Surface, shape)
                    .padding(16.dp),
            ) {
                Text(
                    text = "Verify your bot token is valid and Telegram is reachable.",
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextDim,
                )
                Spacer(modifier = Modifier.height(12.dp))

                Button(
                    onClick = {
                        if (testStatus == "Loading") return@Button
                        testStatus = "Loading"
                        testMessage = ""
                        val token = config?.telegramBotToken ?: ""
                        if (token.isBlank()) {
                            testStatus = "Error"
                            testMessage = "Bot token is empty."
                            return@Button
                        }
                        
                        scope.launch {
                            val result = testTelegramBot(token)
                            if (result.isSuccess) {
                                testStatus = "Success"
                                testMessage = "Bot connected as @${result.getOrNull()}"
                            } else {
                                testStatus = "Error"
                                testMessage = result.exceptionOrNull()?.message ?: "Connection failed"
                            }
                        }
                    },
                    enabled = testStatus != "Loading",
                    modifier = Modifier.fillMaxWidth(),
                    shape = shape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = SeekerClawColors.ActionPrimary,
                        contentColor = Color.White,
                    ),
                ) {
                    if (testStatus == "Loading") {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = Color.White,
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Testing...", fontFamily = RethinkSans, fontSize = 14.sp)
                    } else {
                        Text("Test Bot", fontFamily = RethinkSans, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                    }
                }

                if (testStatus == "Success" || testStatus == "Error") {
                    Spacer(modifier = Modifier.height(12.dp))
                    Text(
                        text = testMessage,
                        fontFamily = RethinkSans,
                        fontSize = 13.sp,
                        color = if (testStatus == "Success") SeekerClawColors.ActionPrimary else SeekerClawColors.Error,
                    )
                }
            }
        }
    }

    if (editField != null) {
        ProviderEditDialog(
            editField = editField,
            editLabel = editLabel,
            editValue = editValue,
            onValueChange = { editValue = it },
            onSave = {
                val field = editField ?: return@ProviderEditDialog
                val trimmed = editValue.trim()
                if (trimmed.isNotEmpty()) {
                    saveField(field, trimmed)
                } else if (field == "telegramOwnerId") {
                    // Allow clearing Owner ID to fallback to Auto-detect
                    saveField(field, trimmed)
                }
                editField = null
            },
            onDismiss = { editField = null }
        )
    }
}

private suspend fun testTelegramBot(token: String): Result<String> = withContext(Dispatchers.IO) {
    runCatching {
        // Safe to use token in URL since we catch all exceptions and only return parsed logic
        val url = URL("https://api.telegram.org/bot$token/getMe")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.connectTimeout = 15000
        conn.readTimeout = 15000

        try {
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val responseText = stream?.bufferedReader()?.use { it.readText() } ?: ""
            
            if (status in 200..299) {
                val json = JSONObject(responseText)
                if (json.getBoolean("ok")) {
                    val result = json.getJSONObject("result")
                    return@runCatching result.getString("username")
                } else {
                    error(json.optString("description", "Unknown Telegram error"))
                }
            } else {
                var errorMessage = "HTTP $status"
                try {
                    val json = JSONObject(responseText)
                    if (json.has("description")) {
                        errorMessage += ": ${json.getString("description")}"
                    }
                } catch (e: Exception) {
                    // Ignore JSON parse error on generic failure
                }
                error("Connection failed ($errorMessage)")
            }
        } finally {
            conn.disconnect()
        }
    }
}
