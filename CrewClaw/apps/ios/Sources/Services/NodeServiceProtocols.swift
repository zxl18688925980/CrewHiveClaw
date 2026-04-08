import CoreLocation
import Foundation
import CrewClawKit
import UIKit

typealias CrewClawCameraSnapResult = (format: String, base64: String, width: Int, height: Int)
typealias CrewClawCameraClipResult = (format: String, base64: String, durationMs: Int, hasAudio: Bool)

protocol CameraServicing: Sendable {
    func listDevices() async -> [CameraController.CameraDeviceInfo]
    func snap(params: CrewClawCameraSnapParams) async throws -> CrewClawCameraSnapResult
    func clip(params: CrewClawCameraClipParams) async throws -> CrewClawCameraClipResult
}

protocol ScreenRecordingServicing: Sendable {
    func record(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> String
}

@MainActor
protocol LocationServicing: Sendable {
    func authorizationStatus() -> CLAuthorizationStatus
    func accuracyAuthorization() -> CLAccuracyAuthorization
    func ensureAuthorization(mode: CrewClawLocationMode) async -> CLAuthorizationStatus
    func currentLocation(
        params: CrewClawLocationGetParams,
        desiredAccuracy: CrewClawLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    func startLocationUpdates(
        desiredAccuracy: CrewClawLocationAccuracy,
        significantChangesOnly: Bool) -> AsyncStream<CLLocation>
    func stopLocationUpdates()
    func startMonitoringSignificantLocationChanges(onUpdate: @escaping @Sendable (CLLocation) -> Void)
    func stopMonitoringSignificantLocationChanges()
}

@MainActor
protocol DeviceStatusServicing: Sendable {
    func status() async throws -> CrewClawDeviceStatusPayload
    func info() -> CrewClawDeviceInfoPayload
}

protocol PhotosServicing: Sendable {
    func latest(params: CrewClawPhotosLatestParams) async throws -> CrewClawPhotosLatestPayload
}

protocol ContactsServicing: Sendable {
    func search(params: CrewClawContactsSearchParams) async throws -> CrewClawContactsSearchPayload
    func add(params: CrewClawContactsAddParams) async throws -> CrewClawContactsAddPayload
}

protocol CalendarServicing: Sendable {
    func events(params: CrewClawCalendarEventsParams) async throws -> CrewClawCalendarEventsPayload
    func add(params: CrewClawCalendarAddParams) async throws -> CrewClawCalendarAddPayload
}

protocol RemindersServicing: Sendable {
    func list(params: CrewClawRemindersListParams) async throws -> CrewClawRemindersListPayload
    func add(params: CrewClawRemindersAddParams) async throws -> CrewClawRemindersAddPayload
}

protocol MotionServicing: Sendable {
    func activities(params: CrewClawMotionActivityParams) async throws -> CrewClawMotionActivityPayload
    func pedometer(params: CrewClawPedometerParams) async throws -> CrewClawPedometerPayload
}

struct WatchMessagingStatus: Sendable, Equatable {
    var supported: Bool
    var paired: Bool
    var appInstalled: Bool
    var reachable: Bool
    var activationState: String
}

struct WatchQuickReplyEvent: Sendable, Equatable {
    var replyId: String
    var promptId: String
    var actionId: String
    var actionLabel: String?
    var sessionKey: String?
    var note: String?
    var sentAtMs: Int?
    var transport: String
}

struct WatchNotificationSendResult: Sendable, Equatable {
    var deliveredImmediately: Bool
    var queuedForDelivery: Bool
    var transport: String
}

protocol WatchMessagingServicing: AnyObject, Sendable {
    func status() async -> WatchMessagingStatus
    func setReplyHandler(_ handler: (@Sendable (WatchQuickReplyEvent) -> Void)?)
    func sendNotification(
        id: String,
        params: CrewClawWatchNotifyParams) async throws -> WatchNotificationSendResult
}

extension CameraController: CameraServicing {}
extension ScreenRecordService: ScreenRecordingServicing {}
extension LocationService: LocationServicing {}
