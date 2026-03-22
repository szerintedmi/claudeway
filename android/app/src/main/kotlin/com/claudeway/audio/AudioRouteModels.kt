package com.claudeway.audio

import android.annotation.SuppressLint
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import androidx.annotation.RequiresApi

const val AUTO_ROUTE_ID = -1
const val PHONE_SPEAKER_ROUTE_ID = -2
const val EARPIECE_ROUTE_ID = -3

enum class AudioRouteState {
    NoDevice,
    Available,
    Routing,
    Routed,
    Error,
    UnsupportedApi,
}

data class AudioDevice(
    val id: Int,
    val name: String,
    val type: Int,
    val productName: String,
    val iconOverride: String? = null,
) {
    val icon: String get() = iconOverride ?: when (type) {
        AudioDeviceInfo.TYPE_UNKNOWN -> "auto"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "smartphone"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "headphones"
        else -> "smartphone"
    }

    val subtitle: String? get() {
        val prod = productName.trim()
        return if (prod.isNotEmpty() && prod != name) prod else null
    }
}

data class DeviceToast(val message: String)

@SuppressLint("InlinedApi")
internal fun AudioDeviceInfo.isBtDevice(): Boolean =
    type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || type == AudioDeviceInfo.TYPE_BLE_HEADSET

internal fun friendlyDeviceName(type: Int?): String = when (type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Connected Headset"
    AudioDeviceInfo.TYPE_BLE_HEADSET -> "Connected Headset"
    else -> "Audio Device"
}

internal fun AudioDeviceInfo.toRouteOption(): AudioDevice = AudioDevice(
    id = id,
    name = friendlyDeviceName(type),
    type = type,
    productName = productName?.toString() ?: "",
    iconOverride = "headphones",
)

@RequiresApi(Build.VERSION_CODES.S)
internal fun buildAvailableRoutes(audioManager: AudioManager): List<AudioDevice> {
    val routes = mutableListOf(
        AudioDevice(
            id = AUTO_ROUTE_ID,
            name = "Automatic",
            type = AudioDeviceInfo.TYPE_UNKNOWN,
            productName = "Use connected headset when available, otherwise phone speaker",
            iconOverride = "auto",
        )
    )

    audioManager.availableCommunicationDevices
        .filter { it.isBtDevice() }
        .forEach { routes.add(it.toRouteOption()) }

    routes.add(
        AudioDevice(
            id = PHONE_SPEAKER_ROUTE_ID,
            name = "Phone Speaker",
            type = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
            productName = "Built-in speaker with built-in microphone",
            iconOverride = "smartphone",
        )
    )

    if (audioManager.availableCommunicationDevices.any { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }) {
        routes.add(
            AudioDevice(
                id = EARPIECE_ROUTE_ID,
                name = "Earpiece",
                type = AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
                productName = "Earpiece with built-in microphone",
                iconOverride = "earpiece",
            )
        )
    }

    return routes
}

internal fun routeDeviceTypeName(type: Int?): String = when (type) {
    null -> "NONE"
    AudioDeviceInfo.TYPE_UNKNOWN -> "UNKNOWN"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "BUILTIN_SPEAKER"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "BUILTIN_EARPIECE"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BLUETOOTH_SCO"
    AudioDeviceInfo.TYPE_BLE_HEADSET -> "BLE_HEADSET"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BLUETOOTH_A2DP"
    AudioDeviceInfo.TYPE_WIRED_HEADSET -> "WIRED_HEADSET"
    else -> "UNKNOWN($type)"
}
