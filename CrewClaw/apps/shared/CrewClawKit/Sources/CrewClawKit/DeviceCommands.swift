import Foundation

public enum CrewClawDeviceCommand: String, Codable, Sendable {
    case status = "device.status"
    case info = "device.info"
}

public enum CrewClawBatteryState: String, Codable, Sendable {
    case unknown
    case unplugged
    case charging
    case full
}

public enum CrewClawThermalState: String, Codable, Sendable {
    case nominal
    case fair
    case serious
    case critical
}

public enum CrewClawNetworkPathStatus: String, Codable, Sendable {
    case satisfied
    case unsatisfied
    case requiresConnection
}

public enum CrewClawNetworkInterfaceType: String, Codable, Sendable {
    case wifi
    case cellular
    case wired
    case other
}

public struct CrewClawBatteryStatusPayload: Codable, Sendable, Equatable {
    public var level: Double?
    public var state: CrewClawBatteryState
    public var lowPowerModeEnabled: Bool

    public init(level: Double?, state: CrewClawBatteryState, lowPowerModeEnabled: Bool) {
        self.level = level
        self.state = state
        self.lowPowerModeEnabled = lowPowerModeEnabled
    }
}

public struct CrewClawThermalStatusPayload: Codable, Sendable, Equatable {
    public var state: CrewClawThermalState

    public init(state: CrewClawThermalState) {
        self.state = state
    }
}

public struct CrewClawStorageStatusPayload: Codable, Sendable, Equatable {
    public var totalBytes: Int64
    public var freeBytes: Int64
    public var usedBytes: Int64

    public init(totalBytes: Int64, freeBytes: Int64, usedBytes: Int64) {
        self.totalBytes = totalBytes
        self.freeBytes = freeBytes
        self.usedBytes = usedBytes
    }
}

public struct CrewClawNetworkStatusPayload: Codable, Sendable, Equatable {
    public var status: CrewClawNetworkPathStatus
    public var isExpensive: Bool
    public var isConstrained: Bool
    public var interfaces: [CrewClawNetworkInterfaceType]

    public init(
        status: CrewClawNetworkPathStatus,
        isExpensive: Bool,
        isConstrained: Bool,
        interfaces: [CrewClawNetworkInterfaceType])
    {
        self.status = status
        self.isExpensive = isExpensive
        self.isConstrained = isConstrained
        self.interfaces = interfaces
    }
}

public struct CrewClawDeviceStatusPayload: Codable, Sendable, Equatable {
    public var battery: CrewClawBatteryStatusPayload
    public var thermal: CrewClawThermalStatusPayload
    public var storage: CrewClawStorageStatusPayload
    public var network: CrewClawNetworkStatusPayload
    public var uptimeSeconds: Double

    public init(
        battery: CrewClawBatteryStatusPayload,
        thermal: CrewClawThermalStatusPayload,
        storage: CrewClawStorageStatusPayload,
        network: CrewClawNetworkStatusPayload,
        uptimeSeconds: Double)
    {
        self.battery = battery
        self.thermal = thermal
        self.storage = storage
        self.network = network
        self.uptimeSeconds = uptimeSeconds
    }
}

public struct CrewClawDeviceInfoPayload: Codable, Sendable, Equatable {
    public var deviceName: String
    public var modelIdentifier: String
    public var systemName: String
    public var systemVersion: String
    public var appVersion: String
    public var appBuild: String
    public var locale: String

    public init(
        deviceName: String,
        modelIdentifier: String,
        systemName: String,
        systemVersion: String,
        appVersion: String,
        appBuild: String,
        locale: String)
    {
        self.deviceName = deviceName
        self.modelIdentifier = modelIdentifier
        self.systemName = systemName
        self.systemVersion = systemVersion
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.locale = locale
    }
}
