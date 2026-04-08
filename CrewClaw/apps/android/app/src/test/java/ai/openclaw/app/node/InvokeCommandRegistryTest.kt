package ai.openclaw.app.node

import ai.openclaw.app.protocol.CrewClawCalendarCommand
import ai.openclaw.app.protocol.CrewClawCameraCommand
import ai.openclaw.app.protocol.CrewClawCapability
import ai.openclaw.app.protocol.CrewClawContactsCommand
import ai.openclaw.app.protocol.CrewClawDeviceCommand
import ai.openclaw.app.protocol.CrewClawLocationCommand
import ai.openclaw.app.protocol.CrewClawMotionCommand
import ai.openclaw.app.protocol.CrewClawNotificationsCommand
import ai.openclaw.app.protocol.CrewClawPhotosCommand
import ai.openclaw.app.protocol.CrewClawSmsCommand
import ai.openclaw.app.protocol.CrewClawSystemCommand
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InvokeCommandRegistryTest {
  private val coreCapabilities =
    setOf(
      CrewClawCapability.Canvas.rawValue,
      CrewClawCapability.Device.rawValue,
      CrewClawCapability.Notifications.rawValue,
      CrewClawCapability.System.rawValue,
      CrewClawCapability.Photos.rawValue,
      CrewClawCapability.Contacts.rawValue,
      CrewClawCapability.Calendar.rawValue,
    )

  private val optionalCapabilities =
    setOf(
      CrewClawCapability.Camera.rawValue,
      CrewClawCapability.Location.rawValue,
      CrewClawCapability.Sms.rawValue,
      CrewClawCapability.VoiceWake.rawValue,
      CrewClawCapability.Motion.rawValue,
    )

  private val coreCommands =
    setOf(
      CrewClawDeviceCommand.Status.rawValue,
      CrewClawDeviceCommand.Info.rawValue,
      CrewClawDeviceCommand.Permissions.rawValue,
      CrewClawDeviceCommand.Health.rawValue,
      CrewClawNotificationsCommand.List.rawValue,
      CrewClawNotificationsCommand.Actions.rawValue,
      CrewClawSystemCommand.Notify.rawValue,
      CrewClawPhotosCommand.Latest.rawValue,
      CrewClawContactsCommand.Search.rawValue,
      CrewClawContactsCommand.Add.rawValue,
      CrewClawCalendarCommand.Events.rawValue,
      CrewClawCalendarCommand.Add.rawValue,
    )

  private val optionalCommands =
    setOf(
      CrewClawCameraCommand.Snap.rawValue,
      CrewClawCameraCommand.Clip.rawValue,
      CrewClawCameraCommand.List.rawValue,
      CrewClawLocationCommand.Get.rawValue,
      CrewClawMotionCommand.Activity.rawValue,
      CrewClawMotionCommand.Pedometer.rawValue,
      CrewClawSmsCommand.Send.rawValue,
    )

  private val debugCommands = setOf("debug.logs", "debug.ed25519")

  @Test
  fun advertisedCapabilities_respectsFeatureAvailability() {
    val capabilities = InvokeCommandRegistry.advertisedCapabilities(defaultFlags())

    assertContainsAll(capabilities, coreCapabilities)
    assertMissingAll(capabilities, optionalCapabilities)
  }

  @Test
  fun advertisedCapabilities_includesFeatureCapabilitiesWhenEnabled() {
    val capabilities =
      InvokeCommandRegistry.advertisedCapabilities(
        defaultFlags(
          cameraEnabled = true,
          locationEnabled = true,
          smsAvailable = true,
          voiceWakeEnabled = true,
          motionActivityAvailable = true,
          motionPedometerAvailable = true,
        ),
      )

    assertContainsAll(capabilities, coreCapabilities + optionalCapabilities)
  }

  @Test
  fun advertisedCommands_respectsFeatureAvailability() {
    val commands = InvokeCommandRegistry.advertisedCommands(defaultFlags())

    assertContainsAll(commands, coreCommands)
    assertMissingAll(commands, optionalCommands + debugCommands)
  }

  @Test
  fun advertisedCommands_includesFeatureCommandsWhenEnabled() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        defaultFlags(
          cameraEnabled = true,
          locationEnabled = true,
          smsAvailable = true,
          motionActivityAvailable = true,
          motionPedometerAvailable = true,
          debugBuild = true,
        ),
      )

    assertContainsAll(commands, coreCommands + optionalCommands + debugCommands)
  }

  @Test
  fun advertisedCommands_onlyIncludesSupportedMotionCommands() {
    val commands =
      InvokeCommandRegistry.advertisedCommands(
        NodeRuntimeFlags(
          cameraEnabled = false,
          locationEnabled = false,
          smsAvailable = false,
          voiceWakeEnabled = false,
          motionActivityAvailable = true,
          motionPedometerAvailable = false,
          debugBuild = false,
        ),
      )

    assertTrue(commands.contains(CrewClawMotionCommand.Activity.rawValue))
    assertFalse(commands.contains(CrewClawMotionCommand.Pedometer.rawValue))
  }

  private fun defaultFlags(
    cameraEnabled: Boolean = false,
    locationEnabled: Boolean = false,
    smsAvailable: Boolean = false,
    voiceWakeEnabled: Boolean = false,
    motionActivityAvailable: Boolean = false,
    motionPedometerAvailable: Boolean = false,
    debugBuild: Boolean = false,
  ): NodeRuntimeFlags =
    NodeRuntimeFlags(
      cameraEnabled = cameraEnabled,
      locationEnabled = locationEnabled,
      smsAvailable = smsAvailable,
      voiceWakeEnabled = voiceWakeEnabled,
      motionActivityAvailable = motionActivityAvailable,
      motionPedometerAvailable = motionPedometerAvailable,
      debugBuild = debugBuild,
    )

  private fun assertContainsAll(actual: List<String>, expected: Set<String>) {
    expected.forEach { value -> assertTrue(actual.contains(value)) }
  }

  private fun assertMissingAll(actual: List<String>, forbidden: Set<String>) {
    forbidden.forEach { value -> assertFalse(actual.contains(value)) }
  }
}
