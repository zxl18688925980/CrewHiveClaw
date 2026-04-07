package ai.openclaw.app.node

import ai.openclaw.app.protocol.CrewClawCalendarCommand
import ai.openclaw.app.protocol.CrewClawCanvasA2UICommand
import ai.openclaw.app.protocol.CrewClawCanvasCommand
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

data class NodeRuntimeFlags(
  val cameraEnabled: Boolean,
  val locationEnabled: Boolean,
  val smsAvailable: Boolean,
  val voiceWakeEnabled: Boolean,
  val motionActivityAvailable: Boolean,
  val motionPedometerAvailable: Boolean,
  val debugBuild: Boolean,
)

enum class InvokeCommandAvailability {
  Always,
  CameraEnabled,
  LocationEnabled,
  SmsAvailable,
  MotionActivityAvailable,
  MotionPedometerAvailable,
  DebugBuild,
}

enum class NodeCapabilityAvailability {
  Always,
  CameraEnabled,
  LocationEnabled,
  SmsAvailable,
  VoiceWakeEnabled,
  MotionAvailable,
}

data class NodeCapabilitySpec(
  val name: String,
  val availability: NodeCapabilityAvailability = NodeCapabilityAvailability.Always,
)

data class InvokeCommandSpec(
  val name: String,
  val requiresForeground: Boolean = false,
  val availability: InvokeCommandAvailability = InvokeCommandAvailability.Always,
)

object InvokeCommandRegistry {
  val capabilityManifest: List<NodeCapabilitySpec> =
    listOf(
      NodeCapabilitySpec(name = CrewClawCapability.Canvas.rawValue),
      NodeCapabilitySpec(name = CrewClawCapability.Device.rawValue),
      NodeCapabilitySpec(name = CrewClawCapability.Notifications.rawValue),
      NodeCapabilitySpec(name = CrewClawCapability.System.rawValue),
      NodeCapabilitySpec(
        name = CrewClawCapability.Camera.rawValue,
        availability = NodeCapabilityAvailability.CameraEnabled,
      ),
      NodeCapabilitySpec(
        name = CrewClawCapability.Sms.rawValue,
        availability = NodeCapabilityAvailability.SmsAvailable,
      ),
      NodeCapabilitySpec(
        name = CrewClawCapability.VoiceWake.rawValue,
        availability = NodeCapabilityAvailability.VoiceWakeEnabled,
      ),
      NodeCapabilitySpec(
        name = CrewClawCapability.Location.rawValue,
        availability = NodeCapabilityAvailability.LocationEnabled,
      ),
      NodeCapabilitySpec(name = CrewClawCapability.Photos.rawValue),
      NodeCapabilitySpec(name = CrewClawCapability.Contacts.rawValue),
      NodeCapabilitySpec(name = CrewClawCapability.Calendar.rawValue),
      NodeCapabilitySpec(
        name = CrewClawCapability.Motion.rawValue,
        availability = NodeCapabilityAvailability.MotionAvailable,
      ),
    )

  val all: List<InvokeCommandSpec> =
    listOf(
      InvokeCommandSpec(
        name = CrewClawCanvasCommand.Present.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = CrewClawCanvasCommand.Hide.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = CrewClawCanvasCommand.Navigate.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = CrewClawCanvasCommand.Eval.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = CrewClawCanvasCommand.Snapshot.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = CrewClawCanvasA2UICommand.Push.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = CrewClawCanvasA2UICommand.PushJSONL.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = CrewClawCanvasA2UICommand.Reset.rawValue,
        requiresForeground = true,
      ),
      InvokeCommandSpec(
        name = CrewClawSystemCommand.Notify.rawValue,
      ),
      InvokeCommandSpec(
        name = CrewClawCameraCommand.List.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = CrewClawCameraCommand.Snap.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = CrewClawCameraCommand.Clip.rawValue,
        requiresForeground = true,
        availability = InvokeCommandAvailability.CameraEnabled,
      ),
      InvokeCommandSpec(
        name = CrewClawLocationCommand.Get.rawValue,
        availability = InvokeCommandAvailability.LocationEnabled,
      ),
      InvokeCommandSpec(
        name = CrewClawDeviceCommand.Status.rawValue,
      ),
      InvokeCommandSpec(
        name = CrewClawDeviceCommand.Info.rawValue,
      ),
      InvokeCommandSpec(
        name = CrewClawDeviceCommand.Permissions.rawValue,
      ),
      InvokeCommandSpec(
        name = CrewClawDeviceCommand.Health.rawValue,
      ),
      InvokeCommandSpec(
        name = CrewClawNotificationsCommand.List.rawValue,
      ),
      InvokeCommandSpec(
        name = CrewClawNotificationsCommand.Actions.rawValue,
      ),
      InvokeCommandSpec(
        name = CrewClawPhotosCommand.Latest.rawValue,
      ),
      InvokeCommandSpec(
        name = CrewClawContactsCommand.Search.rawValue,
      ),
      InvokeCommandSpec(
        name = CrewClawContactsCommand.Add.rawValue,
      ),
      InvokeCommandSpec(
        name = CrewClawCalendarCommand.Events.rawValue,
      ),
      InvokeCommandSpec(
        name = CrewClawCalendarCommand.Add.rawValue,
      ),
      InvokeCommandSpec(
        name = CrewClawMotionCommand.Activity.rawValue,
        availability = InvokeCommandAvailability.MotionActivityAvailable,
      ),
      InvokeCommandSpec(
        name = CrewClawMotionCommand.Pedometer.rawValue,
        availability = InvokeCommandAvailability.MotionPedometerAvailable,
      ),
      InvokeCommandSpec(
        name = CrewClawSmsCommand.Send.rawValue,
        availability = InvokeCommandAvailability.SmsAvailable,
      ),
      InvokeCommandSpec(
        name = "debug.logs",
        availability = InvokeCommandAvailability.DebugBuild,
      ),
      InvokeCommandSpec(
        name = "debug.ed25519",
        availability = InvokeCommandAvailability.DebugBuild,
      ),
    )

  private val byNameInternal: Map<String, InvokeCommandSpec> = all.associateBy { it.name }

  fun find(command: String): InvokeCommandSpec? = byNameInternal[command]

  fun advertisedCapabilities(flags: NodeRuntimeFlags): List<String> {
    return capabilityManifest
      .filter { spec ->
        when (spec.availability) {
          NodeCapabilityAvailability.Always -> true
          NodeCapabilityAvailability.CameraEnabled -> flags.cameraEnabled
          NodeCapabilityAvailability.LocationEnabled -> flags.locationEnabled
          NodeCapabilityAvailability.SmsAvailable -> flags.smsAvailable
          NodeCapabilityAvailability.VoiceWakeEnabled -> flags.voiceWakeEnabled
          NodeCapabilityAvailability.MotionAvailable -> flags.motionActivityAvailable || flags.motionPedometerAvailable
        }
      }
      .map { it.name }
  }

  fun advertisedCommands(flags: NodeRuntimeFlags): List<String> {
    return all
      .filter { spec ->
        when (spec.availability) {
          InvokeCommandAvailability.Always -> true
          InvokeCommandAvailability.CameraEnabled -> flags.cameraEnabled
          InvokeCommandAvailability.LocationEnabled -> flags.locationEnabled
          InvokeCommandAvailability.SmsAvailable -> flags.smsAvailable
          InvokeCommandAvailability.MotionActivityAvailable -> flags.motionActivityAvailable
          InvokeCommandAvailability.MotionPedometerAvailable -> flags.motionPedometerAvailable
          InvokeCommandAvailability.DebugBuild -> flags.debugBuild
        }
      }
      .map { it.name }
  }
}
