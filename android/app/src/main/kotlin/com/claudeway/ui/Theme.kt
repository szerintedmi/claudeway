package com.claudeway.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.googlefonts.Font
import androidx.compose.ui.text.googlefonts.GoogleFont

/** Obsidian dark theme — fixed palette per voice-input-ux-rehaul spec. */
object ObsidianTokens {
    val Background = Color(0xFF131313)
    val Surface = Color(0xFF131313)
    val SurfaceContainerLowest = Color(0xFF0E0E0E)
    val SurfaceContainerLow = Color(0xFF1C1B1B)
    val SurfaceContainer = Color(0xFF20201F)
    val SurfaceContainerHigh = Color(0xFF2A2A2A)
    val SurfaceContainerHighest = Color(0xFF353535)
    val Primary = Color(0xFFFFB59E)
    val PrimaryContainer = Color(0xFFD97757)
    val OnPrimary = Color(0xFF5C1902)
    val OnPrimaryContainer = Color(0xFF541400)
    val OnSurface = Color(0xFFE5E2E1)
    val OnSurfaceVariant = Color(0xFFDBC1B9)
    val OutlineVariant = Color(0xFF55433D)
    val Tertiary = Color(0xFFE3C0A2)
    val Error = Color(0xFFFFB4AB)
    val ErrorContainer = Color(0xFF93000A)
    val OnErrorContainer = Color(0xFFFFDAD6)
}

private val ObsidianColorScheme = darkColorScheme(
    primary = ObsidianTokens.Primary,
    onPrimary = ObsidianTokens.OnPrimary,
    primaryContainer = ObsidianTokens.PrimaryContainer,
    onPrimaryContainer = ObsidianTokens.OnPrimaryContainer,
    secondary = Color(0xFFCEC5C0),
    onSecondary = Color(0xFF342F2C),
    secondaryContainer = Color(0xFF4B4642),
    onSecondaryContainer = Color(0xFFBCB3AF),
    tertiary = ObsidianTokens.Tertiary,
    onTertiary = Color(0xFF412C17),
    tertiaryContainer = Color(0xFFAB8C70),
    onTertiaryContainer = Color(0xFF3B2611),
    error = ObsidianTokens.Error,
    onError = Color(0xFF690005),
    errorContainer = ObsidianTokens.ErrorContainer,
    onErrorContainer = ObsidianTokens.OnErrorContainer,
    background = ObsidianTokens.Background,
    onBackground = ObsidianTokens.OnSurface,
    surface = ObsidianTokens.Surface,
    onSurface = ObsidianTokens.OnSurface,
    surfaceVariant = ObsidianTokens.SurfaceContainerHighest,
    onSurfaceVariant = ObsidianTokens.OnSurfaceVariant,
    outline = Color(0xFFA38C85),
    outlineVariant = ObsidianTokens.OutlineVariant,
    inverseSurface = Color(0xFFE5E2E1),
    inverseOnSurface = Color(0xFF313030),
    inversePrimary = Color(0xFF99462A),
    surfaceTint = Color(0xFFFFB59E),
    surfaceContainerLowest = ObsidianTokens.SurfaceContainerLowest,
    surfaceContainerLow = ObsidianTokens.SurfaceContainerLow,
    surfaceContainer = ObsidianTokens.SurfaceContainer,
    surfaceContainerHigh = ObsidianTokens.SurfaceContainerHigh,
    surfaceContainerHighest = ObsidianTokens.SurfaceContainerHighest,
    surfaceDim = Color(0xFF131313),
    surfaceBright = Color(0xFF393939),
)

// --- Typography: Manrope (headlines, bold) + Inter (body, labels) ---

private val fontProvider = GoogleFont.Provider(
    providerAuthority = "com.google.android.gms.fonts",
    providerPackage = "com.google.android.gms",
    certificates = com.claudeway.R.array.com_google_android_gms_fonts_certs,
)

private val ManropeFamily = FontFamily(
    Font(GoogleFont("Manrope"), fontProvider, weight = FontWeight.Normal),
    Font(GoogleFont("Manrope"), fontProvider, weight = FontWeight.Bold),
    Font(GoogleFont("Manrope"), fontProvider, weight = FontWeight.ExtraBold),
)

private val InterFamily = FontFamily(
    Font(GoogleFont("Inter"), fontProvider, weight = FontWeight.Normal),
    Font(GoogleFont("Inter"), fontProvider, weight = FontWeight.Medium),
    Font(GoogleFont("Inter"), fontProvider, weight = FontWeight.SemiBold),
)

private val baseline = Typography()

private val ObsidianTypography = Typography(
    // Headlines use Manrope (bold)
    displayLarge = baseline.displayLarge.copy(fontFamily = ManropeFamily, fontWeight = FontWeight.ExtraBold),
    displayMedium = baseline.displayMedium.copy(fontFamily = ManropeFamily, fontWeight = FontWeight.Bold),
    displaySmall = baseline.displaySmall.copy(fontFamily = ManropeFamily, fontWeight = FontWeight.Bold),
    headlineLarge = baseline.headlineLarge.copy(fontFamily = ManropeFamily, fontWeight = FontWeight.Bold),
    headlineMedium = baseline.headlineMedium.copy(fontFamily = ManropeFamily, fontWeight = FontWeight.Bold),
    headlineSmall = baseline.headlineSmall.copy(fontFamily = ManropeFamily, fontWeight = FontWeight.Bold),
    titleLarge = baseline.titleLarge.copy(fontFamily = ManropeFamily, fontWeight = FontWeight.Bold),
    titleMedium = baseline.titleMedium.copy(fontFamily = ManropeFamily, fontWeight = FontWeight.Bold),
    titleSmall = baseline.titleSmall.copy(fontFamily = ManropeFamily, fontWeight = FontWeight.Medium),
    // Body and labels use Inter
    bodyLarge = baseline.bodyLarge.copy(fontFamily = InterFamily),
    bodyMedium = baseline.bodyMedium.copy(fontFamily = InterFamily),
    bodySmall = baseline.bodySmall.copy(fontFamily = InterFamily),
    labelLarge = baseline.labelLarge.copy(fontFamily = InterFamily, fontWeight = FontWeight.SemiBold),
    labelMedium = baseline.labelMedium.copy(fontFamily = InterFamily, fontWeight = FontWeight.Medium),
    labelSmall = baseline.labelSmall.copy(fontFamily = InterFamily),
)

@Composable
fun ClaudewayTheme(
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = ObsidianColorScheme,
        typography = ObsidianTypography,
        content = content,
    )
}
