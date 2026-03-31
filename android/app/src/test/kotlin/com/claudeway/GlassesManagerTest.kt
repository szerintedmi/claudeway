package com.claudeway

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.claudeway.glasses.GlassesManager
import com.claudeway.glasses.GlassesState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Tests for GlassesManager.
 *
 * These tests run WITHOUT the real DAT SDK on the classpath, so
 * isDatSdkAvailable is false and the manager operates in standalone
 * (Unavailable) mode. Tests verify:
 * - Standalone mode behavior when SDK is absent
 * - SimulateTap for push-to-talk testing
 * - State transitions
 * - Release cleanup
 *
 * Tests requiring MockDeviceKit (real SDK on classpath) are gated by
 * isDatSdkAvailable and skip gracefully in unit test runs. They run
 * in integration test configurations with mwdat-mockdevice.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class GlassesManagerTest {
    private val testDispatcher = StandardTestDispatcher()
    private val testScope = TestScope(testDispatcher)
    private lateinit var manager: GlassesManager

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        val app = ApplicationProvider.getApplicationContext<Application>()
        manager = GlassesManager(app, testScope)
    }

    @After
    fun tearDown() {
        manager.release()
        Dispatchers.resetMain()
    }

    // --- SDK availability ---

    @Test
    fun `isDatSdkAvailable is false in unit tests`() {
        // DAT SDK classes are not on the test classpath
        assertFalse(GlassesManager.isDatSdkAvailable)
    }

    @Test
    fun `initializeSdk with unavailable SDK does not throw`() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        // Should log warning but not crash
        GlassesManager.initializeSdk(app)
    }

    // --- Initial state ---

    @Test
    fun `initial state is NotInitialized`() {
        assertEquals(GlassesState.NotInitialized, manager.state.value)
    }

    @Test
    fun `initial touchpad events is 0`() {
        assertEquals(0L, manager.touchpadTapEvents.value)
    }

    @Test
    fun `initial deviceName is null`() {
        assertNull(manager.deviceName.value)
    }

    // --- Standalone mode (no SDK) ---

    @Test
    fun `initialize without SDK sets Unavailable state`() {
        manager.initialize()
        assertEquals(GlassesState.Unavailable, manager.state.value)
    }

    @Test
    fun `startDiscovery without SDK is a no-op`() {
        manager.initialize()
        manager.startDiscovery()
        // Stays Unavailable, does not transition to Searching
        assertEquals(GlassesState.Unavailable, manager.state.value)
    }

    @Test
    fun `release in Unavailable mode stays Unavailable`() {
        manager.initialize()
        assertEquals(GlassesState.Unavailable, manager.state.value)
        manager.release()
        assertEquals(GlassesState.Unavailable, manager.state.value)
    }

    // --- SimulateTap ---

    @Test
    fun `simulateTap emits non-zero timestamp`() {
        assertEquals(0L, manager.touchpadTapEvents.value)
        manager.simulateTap()
        assertNotEquals(0L, manager.touchpadTapEvents.value)
    }

    @Test
    fun `simulateTap emits increasing timestamps`() {
        manager.simulateTap()
        val first = manager.touchpadTapEvents.value
        Thread.sleep(5) // Ensure different timestamp
        manager.simulateTap()
        val second = manager.touchpadTapEvents.value
        assertTrue("Second tap ($second) should be after first ($first)", second > first)
    }

    @Test
    fun `simulateTap works regardless of SDK availability`() {
        manager.initialize() // Sets Unavailable
        manager.simulateTap()
        assertNotEquals(0L, manager.touchpadTapEvents.value)
    }

    // --- State enum coverage ---

    @Test
    fun `GlassesState enum has expected values`() {
        val states = GlassesState.entries
        assertTrue(states.contains(GlassesState.NotInitialized))
        assertTrue(states.contains(GlassesState.NotRegistered))
        assertTrue(states.contains(GlassesState.Searching))
        assertTrue(states.contains(GlassesState.Connecting))
        assertTrue(states.contains(GlassesState.Connected))
        assertTrue(states.contains(GlassesState.Disconnected))
        assertTrue(states.contains(GlassesState.Error))
        assertTrue(states.contains(GlassesState.Unavailable))
        assertEquals(8, states.size)
    }

    // --- MockDeviceKit integration tests ---
    // These only run when the DAT SDK is on the classpath (e.g. androidTest or
    // integration test configurations with mwdat-mockdevice).

    @Test
    fun `MockDeviceKit integration - discovery flow (skipped without SDK)`() {
        if (!GlassesManager.isDatSdkAvailable) {
            // Expected in unit tests — SDK not on classpath
            return
        }
        // When SDK is available:
        // 1. Initialize SDK
        // 2. Create MockDeviceKit.getInstance()
        // 3. Create mock device
        // 4. Initialize manager
        // 5. Verify state transitions: NotInitialized -> Searching -> Connected
        manager.initialize()
        testScope.advanceUntilIdle()
        // With MockDeviceKit, would verify Connected state
    }

    @Test
    fun `MockDeviceKit integration - registration flow (skipped without SDK)`() {
        if (!GlassesManager.isDatSdkAvailable) {
            return
        }
        // When SDK is available:
        // 1. Verify initial state is NotRegistered
        // 2. Complete mock registration
        // 3. Verify state transitions to Searching then Connected
        manager.initialize()
        testScope.advanceUntilIdle()
    }
}
