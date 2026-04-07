import Foundation

public enum CrewClawCameraCommand: String, Codable, Sendable {
    case list = "camera.list"
    case snap = "camera.snap"
    case clip = "camera.clip"
}

public enum CrewClawCameraFacing: String, Codable, Sendable {
    case back
    case front
}

public enum CrewClawCameraImageFormat: String, Codable, Sendable {
    case jpg
    case jpeg
}

public enum CrewClawCameraVideoFormat: String, Codable, Sendable {
    case mp4
}

public struct CrewClawCameraSnapParams: Codable, Sendable, Equatable {
    public var facing: CrewClawCameraFacing?
    public var maxWidth: Int?
    public var quality: Double?
    public var format: CrewClawCameraImageFormat?
    public var deviceId: String?
    public var delayMs: Int?

    public init(
        facing: CrewClawCameraFacing? = nil,
        maxWidth: Int? = nil,
        quality: Double? = nil,
        format: CrewClawCameraImageFormat? = nil,
        deviceId: String? = nil,
        delayMs: Int? = nil)
    {
        self.facing = facing
        self.maxWidth = maxWidth
        self.quality = quality
        self.format = format
        self.deviceId = deviceId
        self.delayMs = delayMs
    }
}

public struct CrewClawCameraClipParams: Codable, Sendable, Equatable {
    public var facing: CrewClawCameraFacing?
    public var durationMs: Int?
    public var includeAudio: Bool?
    public var format: CrewClawCameraVideoFormat?
    public var deviceId: String?

    public init(
        facing: CrewClawCameraFacing? = nil,
        durationMs: Int? = nil,
        includeAudio: Bool? = nil,
        format: CrewClawCameraVideoFormat? = nil,
        deviceId: String? = nil)
    {
        self.facing = facing
        self.durationMs = durationMs
        self.includeAudio = includeAudio
        self.format = format
        self.deviceId = deviceId
    }
}
