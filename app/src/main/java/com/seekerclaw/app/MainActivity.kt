package com.seekerclaw.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.seekerclaw.app.ui.navigation.SeekerClawNavHost
import com.seekerclaw.app.ui.theme.SeekerClawTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            SeekerClawTheme {
                SeekerClawNavHost()
            }
        }
    }
}
