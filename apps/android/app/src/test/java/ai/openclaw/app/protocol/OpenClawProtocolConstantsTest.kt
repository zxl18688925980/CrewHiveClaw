package ai.openclaw.app.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class CrewClawProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.present", CrewClawCanvasCommand.Present.rawValue)
    assertEquals("canvas.hide", CrewClawCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", CrewClawCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", CrewClawCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", CrewClawCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", CrewClawCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", CrewClawCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", CrewClawCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", CrewClawCapability.Canvas.rawValue)
    assertEquals("camera", CrewClawCapability.Camera.rawValue)
    assertEquals("voiceWake", CrewClawCapability.VoiceWake.rawValue)
    assertEquals("location", CrewClawCapability.Location.rawValue)
    assertEquals("sms", CrewClawCapability.Sms.rawValue)
    assertEquals("device", CrewClawCapability.Device.rawValue)
    assertEquals("notifications", CrewClawCapability.Notifications.rawValue)
    assertEquals("system", CrewClawCapability.System.rawValue)
    assertEquals("photos", CrewClawCapability.Photos.rawValue)
    assertEquals("contacts", CrewClawCapability.Contacts.rawValue)
    assertEquals("calendar", CrewClawCapability.Calendar.rawValue)
    assertEquals("motion", CrewClawCapability.Motion.rawValue)
  }

  @Test
  fun cameraCommandsUseStableStrings() {
    assertEquals("camera.list", CrewClawCameraCommand.List.rawValue)
    assertEquals("camera.snap", CrewClawCameraCommand.Snap.rawValue)
    assertEquals("camera.clip", CrewClawCameraCommand.Clip.rawValue)
  }

  @Test
  fun notificationsCommandsUseStableStrings() {
    assertEquals("notifications.list", CrewClawNotificationsCommand.List.rawValue)
    assertEquals("notifications.actions", CrewClawNotificationsCommand.Actions.rawValue)
  }

  @Test
  fun deviceCommandsUseStableStrings() {
    assertEquals("device.status", CrewClawDeviceCommand.Status.rawValue)
    assertEquals("device.info", CrewClawDeviceCommand.Info.rawValue)
    assertEquals("device.permissions", CrewClawDeviceCommand.Permissions.rawValue)
    assertEquals("device.health", CrewClawDeviceCommand.Health.rawValue)
  }

  @Test
  fun systemCommandsUseStableStrings() {
    assertEquals("system.notify", CrewClawSystemCommand.Notify.rawValue)
  }

  @Test
  fun photosCommandsUseStableStrings() {
    assertEquals("photos.latest", CrewClawPhotosCommand.Latest.rawValue)
  }

  @Test
  fun contactsCommandsUseStableStrings() {
    assertEquals("contacts.search", CrewClawContactsCommand.Search.rawValue)
    assertEquals("contacts.add", CrewClawContactsCommand.Add.rawValue)
  }

  @Test
  fun calendarCommandsUseStableStrings() {
    assertEquals("calendar.events", CrewClawCalendarCommand.Events.rawValue)
    assertEquals("calendar.add", CrewClawCalendarCommand.Add.rawValue)
  }

  @Test
  fun motionCommandsUseStableStrings() {
    assertEquals("motion.activity", CrewClawMotionCommand.Activity.rawValue)
    assertEquals("motion.pedometer", CrewClawMotionCommand.Pedometer.rawValue)
  }
}
