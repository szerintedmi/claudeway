package com.claudeway.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val DarkColorScheme = darkColorScheme(
    primary = Color(0xFF0A9396),
    onPrimary = Color.White,
    primaryContainer = Color(0xFF005F61),
    onPrimaryContainer = Color(0xFFA0F0F2),
    secondary = Color(0xFFBBC8CA),
    surfaceVariant = Color(0xFF2A2A3E),
    background = Color(0xFF1A1A2E),
)

private val LightColorScheme = lightColorScheme(
    primary = Color(0xFF006A6C),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFB0F0F2),
    onPrimaryContainer = Color(0xFF002020),
    secondary = Color(0xFF4A6365),
)

@Composable
fun ClaudewayTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }

    MaterialTheme(
        colorScheme = colorScheme,
        content = content,
    )
}
