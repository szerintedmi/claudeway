package com.claudeway.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Headphones
import androidx.compose.material.icons.filled.Hearing
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.claudeway.audio.AUTO_ROUTE_ID
import com.claudeway.audio.AudioDevice
import com.claudeway.audio.EARPIECE_ROUTE_ID
import com.claudeway.audio.PHONE_SPEAKER_ROUTE_ID

private const val NO_PENDING = Int.MIN_VALUE

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AudioSettingsSheet(
    availableRoutes: List<AudioDevice>,
    activeRouteId: Int?,
    selectedRouteId: Int,
    onApply: (routeId: Int) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var pendingRouteId by remember { mutableIntStateOf(NO_PENDING) }
    val effectiveRouteId = if (pendingRouteId == NO_PENDING) selectedRouteId else pendingRouteId

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = ObsidianTokens.SurfaceContainerLow,
        shape = RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp),
        tonalElevation = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
                .padding(bottom = 32.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Audio Settings",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = ObsidianTokens.Primary,
                )
                Box(
                    modifier = Modifier
                        .size(40.dp)
                        .background(ObsidianTokens.SurfaceContainerHigh, CircleShape)
                        .clickable { onDismiss() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = "Close",
                        tint = ObsidianTokens.OnSurfaceVariant,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))
            Spacer(modifier = Modifier.height(8.dp))

            RouteSection(
                routes = availableRoutes,
                activeRouteId = activeRouteId,
                selectedRouteId = effectiveRouteId,
                onSelect = { pendingRouteId = it },
            )

            Spacer(modifier = Modifier.height(24.dp))

            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp)
                    .background(
                        brush = Brush.horizontalGradient(
                            colors = listOf(
                                ObsidianTokens.PrimaryContainer,
                                ObsidianTokens.Primary,
                            ),
                        ),
                        shape = RoundedCornerShape(16.dp),
                    )
                    .clickable { onApply(effectiveRouteId) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "Apply Route",
                    fontWeight = FontWeight.Bold,
                    color = ObsidianTokens.OnPrimary,
                    fontSize = 16.sp,
                )
            }
        }
    }
}

@Composable
private fun RouteSection(
    routes: List<AudioDevice>,
    activeRouteId: Int?,
    selectedRouteId: Int,
    onSelect: (Int) -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(bottom = 12.dp),
    ) {
        Icon(
            imageVector = Icons.Default.Tune,
            contentDescription = "Audio route",
            tint = ObsidianTokens.Tertiary,
            modifier = Modifier.size(16.dp),
        )
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = "AUDIO ROUTE",
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color = ObsidianTokens.OnSurfaceVariant,
            letterSpacing = 3.sp,
        )
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        routes.forEach { route ->
            RouteRow(
                route = route,
                isSelected = route.id == selectedRouteId,
                isActive = route.id == activeRouteId,
                onClick = { onSelect(route.id) },
            )
        }
    }
}

@Composable
private fun RouteRow(
    route: AudioDevice,
    isSelected: Boolean,
    isActive: Boolean,
    onClick: () -> Unit,
) {
    val bgColor = if (isSelected) ObsidianTokens.SurfaceContainerHighest else ObsidianTokens.SurfaceContainer
    val borderMod = if (isSelected) Modifier.border(
        width = 1.dp,
        color = ObsidianTokens.Primary.copy(alpha = 0.2f),
        shape = RoundedCornerShape(16.dp),
    ) else Modifier

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(borderMod)
            .background(bgColor, RoundedCornerShape(16.dp))
            .clickable(onClick = onClick)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val iconBg = if (isSelected) ObsidianTokens.Primary.copy(alpha = 0.1f) else ObsidianTokens.SurfaceContainerHighest
        val iconColor = if (isSelected) ObsidianTokens.Primary else ObsidianTokens.OnSurfaceVariant

        Box(
            modifier = Modifier
                .size(40.dp)
                .background(iconBg, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = routeIcon(route.id),
                contentDescription = route.name,
                tint = iconColor,
                modifier = Modifier.size(20.dp),
            )
        }

        Spacer(modifier = Modifier.width(16.dp))

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = route.name,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = if (isSelected) ObsidianTokens.OnSurface else ObsidianTokens.OnSurfaceVariant,
            )
            Text(
                text = routeDescription(route),
                style = MaterialTheme.typography.labelSmall,
                color = if (isSelected) ObsidianTokens.Primary.copy(alpha = 0.75f)
                    else ObsidianTokens.OnSurfaceVariant.copy(alpha = 0.6f),
            )
        }

        if (isActive) {
            Text(
                text = "Current",
                style = MaterialTheme.typography.labelSmall,
                color = ObsidianTokens.Tertiary,
                modifier = Modifier.padding(end = 10.dp),
            )
        }

        Box(
            modifier = Modifier
                .size(20.dp)
                .border(
                    width = 2.dp,
                    color = if (isSelected) ObsidianTokens.Primary else ObsidianTokens.OutlineVariant,
                    shape = CircleShape,
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (isSelected) {
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .background(ObsidianTokens.Primary, CircleShape),
                )
            }
        }
    }
}

private fun routeIcon(routeId: Int) = when (routeId) {
    AUTO_ROUTE_ID -> Icons.Default.Tune
    PHONE_SPEAKER_ROUTE_ID -> Icons.Default.Smartphone
    EARPIECE_ROUTE_ID -> Icons.Default.Hearing
    else -> Icons.Default.Headphones
}

private fun routeDescription(route: AudioDevice): String = when (route.id) {
    AUTO_ROUTE_ID -> "Use headset when available, otherwise phone speaker"
    PHONE_SPEAKER_ROUTE_ID -> "Built-in speaker with built-in microphone"
    EARPIECE_ROUTE_ID -> "Private earpiece audio with built-in microphone"
    else -> route.subtitle ?: "Use the connected headset for voice"
}
