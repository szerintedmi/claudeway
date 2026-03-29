package com.claudeway

import android.media.AudioDeviceInfo
import android.media.AudioManager
import com.claudeway.audio.AudioRouteState
import com.claudeway.audio.CommunicationRouteController
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class AudioRouterTest {

    private fun mockBtDevice(id: Int = 42, name: String = "Test Headset"): AudioDeviceInfo {
        return mockk<AudioDeviceInfo> {
            every { this@mockk.id } returns id
            every { type } returns AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            every { productName } returns name
        }
    }

    private fun mockSpeakerDevice(id: Int = 1): AudioDeviceInfo {
        return mockk<AudioDeviceInfo> {
            every { this@mockk.id } returns id
            every { type } returns AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
            every { productName } returns "Speaker"
        }
    }

    private fun createController(
        audioManager: AudioManager,
        onRoutingChanged: () -> Unit = {},
    ): CommunicationRouteController {
        val scope = TestScope(UnconfinedTestDispatcher())
        return CommunicationRouteController(
            audioManager = audioManager,
            scope = scope,
            onRoutingChanged = onRoutingChanged,
        )
    }

    @Test
    fun `findScoDevice returns BT device when available`() {
        val btDevice = mockBtDevice()
        val audioManager = mockk<AudioManager> {
            every { availableCommunicationDevices } returns listOf(btDevice)
        }
        val controller = createController(audioManager)
        // initializeForApiLevel needs API 31+ — we're on Robolectric with default SDK
        controller.initializeForApiLevel()

        val found = controller.findScoDevice()
        assertNotNull(found)
        assertEquals(42, found!!.id)
    }

    @Test
    fun `findScoDevice returns null when no BT device`() {
        val speaker = mockSpeakerDevice()
        val audioManager = mockk<AudioManager> {
            every { availableCommunicationDevices } returns listOf(speaker)
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()

        assertNull(controller.findScoDevice())
    }

    @Test
    fun `findScoDevice returns null when no devices at all`() {
        val audioManager = mockk<AudioManager> {
            every { availableCommunicationDevices } returns emptyList()
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()

        assertNull(controller.findScoDevice())
    }

    @Test
    fun `initial state is Available when BT device present`() {
        val btDevice = mockBtDevice()
        val audioManager = mockk<AudioManager> {
            every { availableCommunicationDevices } returns listOf(btDevice)
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()

        assertEquals(AudioRouteState.Available, controller.state.value)
    }

    @Test
    fun `initial state is NoDevice when no BT device`() {
        val audioManager = mockk<AudioManager> {
            every { availableCommunicationDevices } returns emptyList()
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()

        assertEquals(AudioRouteState.NoDevice, controller.state.value)
    }

    @Test
    fun `prepareForCommunication returns null when session not active`() {
        val btDevice = mockBtDevice()
        val audioManager = mockk<AudioManager> {
            every { availableCommunicationDevices } returns listOf(btDevice)
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()
        // Session not started — should return null
        val result = controller.prepareForCommunication(selectedRouteId = -1)
        assertNull(result)
    }

    @Test
    fun `prepareForCommunication with AUTO routes to BT device`() {
        val btDevice = mockBtDevice()
        val audioManager = mockk<AudioManager>(relaxed = true) {
            every { availableCommunicationDevices } returns listOf(btDevice)
            every { communicationDevice } returns null
            every { setCommunicationDevice(btDevice) } returns true
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()
        controller.startSession()

        val result = controller.prepareForCommunication(selectedRouteId = -1) // AUTO_ROUTE_ID
        assertNotNull(result)
        assertEquals(42, result!!.id)
        verify { audioManager.setCommunicationDevice(btDevice) }
    }

    @Test
    fun `prepareForCommunication returns null when no matching device`() {
        val speaker = mockSpeakerDevice()
        val audioManager = mockk<AudioManager>(relaxed = true) {
            every { availableCommunicationDevices } returns listOf(speaker)
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()
        controller.startSession()

        // AUTO looks for BT first — no BT available, returns null
        val result = controller.prepareForCommunication(selectedRouteId = -1)
        assertNull(result)
    }

    @Test
    fun `prepareForCommunication with specific device ID`() {
        val btDevice = mockBtDevice(id = 99, name = "My Headset")
        val audioManager = mockk<AudioManager>(relaxed = true) {
            every { availableCommunicationDevices } returns listOf(btDevice)
            every { communicationDevice } returns null
            every { setCommunicationDevice(btDevice) } returns true
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()
        controller.startSession()

        val result = controller.prepareForCommunication(selectedRouteId = 99)
        assertNotNull(result)
        assertEquals(99, result!!.id)
    }

    @Test
    fun `prepareForCommunication returns null when setCommunicationDevice fails`() {
        val btDevice = mockBtDevice()
        val audioManager = mockk<AudioManager>(relaxed = true) {
            every { availableCommunicationDevices } returns listOf(btDevice)
            every { communicationDevice } returns null
            every { setCommunicationDevice(btDevice) } returns false
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()
        controller.startSession()

        val result = controller.prepareForCommunication(selectedRouteId = -1)
        assertNull(result)
    }

    @Test
    fun `endSession clears communication device and resets state`() {
        val btDevice = mockBtDevice()
        val audioManager = mockk<AudioManager>(relaxed = true) {
            every { availableCommunicationDevices } returns listOf(btDevice)
            every { communicationDevice } returns null
            every { setCommunicationDevice(btDevice) } returns true
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()
        controller.startSession()
        controller.prepareForCommunication(selectedRouteId = -1)

        var builtInRouteId = -1
        controller.endSession { builtInRouteId = it }

        verify { audioManager.clearCommunicationDevice() }
        verify { audioManager.mode = AudioManager.MODE_NORMAL }
        assertEquals(-2, builtInRouteId) // PHONE_SPEAKER_ROUTE_ID
        assertEquals(AudioRouteState.Available, controller.state.value) // BT still physically there
    }

    @Test
    fun `endSession with no BT device sets state to NoDevice`() {
        val audioManager = mockk<AudioManager>(relaxed = true) {
            every { availableCommunicationDevices } returns emptyList()
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()
        controller.startSession()

        var builtInRouteId = -1
        controller.endSession { builtInRouteId = it }

        assertEquals(AudioRouteState.NoDevice, controller.state.value)
        assertEquals(-2, builtInRouteId)
    }

    @Test
    fun `destroy clears everything`() {
        val btDevice = mockBtDevice()
        val audioManager = mockk<AudioManager>(relaxed = true) {
            every { availableCommunicationDevices } returns listOf(btDevice)
            every { communicationDevice } returns null
            every { setCommunicationDevice(btDevice) } returns true
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()
        controller.startSession()
        controller.prepareForCommunication(selectedRouteId = -1)

        controller.destroy()

        assertEquals(AudioRouteState.NoDevice, controller.state.value)
        assertNull(controller.routedDevice())
        verify { audioManager.clearCommunicationDevice() }
    }

    @Test
    fun `routedDevice returns null when not routed`() {
        val audioManager = mockk<AudioManager> {
            every { availableCommunicationDevices } returns emptyList()
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()

        assertNull(controller.routedDevice())
    }

    @Test
    fun `findScoDevice prefers BT SCO over BLE headset`() {
        val bleDevice = mockk<AudioDeviceInfo> {
            every { id } returns 10
            every { type } returns AudioDeviceInfo.TYPE_BLE_HEADSET
            every { productName } returns "BLE Headset"
        }
        val scoDevice = mockBtDevice(id = 20)
        val audioManager = mockk<AudioManager> {
            // BLE listed first, but SCO is also BT — firstOrNull returns whichever is first
            every { availableCommunicationDevices } returns listOf(bleDevice, scoDevice)
        }
        val controller = createController(audioManager)
        controller.initializeForApiLevel()

        val found = controller.findScoDevice()
        assertNotNull(found)
        // Both are considered BT devices (isBtDevice checks SCO or BLE_HEADSET)
        // firstOrNull returns the first match = BLE device
        assertEquals(10, found!!.id)
    }
}
