import Foundation

public enum CrewClawRemindersCommand: String, Codable, Sendable {
    case list = "reminders.list"
    case add = "reminders.add"
}

public enum CrewClawReminderStatusFilter: String, Codable, Sendable {
    case incomplete
    case completed
    case all
}

public struct CrewClawRemindersListParams: Codable, Sendable, Equatable {
    public var status: CrewClawReminderStatusFilter?
    public var limit: Int?

    public init(status: CrewClawReminderStatusFilter? = nil, limit: Int? = nil) {
        self.status = status
        self.limit = limit
    }
}

public struct CrewClawRemindersAddParams: Codable, Sendable, Equatable {
    public var title: String
    public var dueISO: String?
    public var notes: String?
    public var listId: String?
    public var listName: String?

    public init(
        title: String,
        dueISO: String? = nil,
        notes: String? = nil,
        listId: String? = nil,
        listName: String? = nil)
    {
        self.title = title
        self.dueISO = dueISO
        self.notes = notes
        self.listId = listId
        self.listName = listName
    }
}

public struct CrewClawReminderPayload: Codable, Sendable, Equatable {
    public var identifier: String
    public var title: String
    public var dueISO: String?
    public var completed: Bool
    public var listName: String?

    public init(
        identifier: String,
        title: String,
        dueISO: String? = nil,
        completed: Bool,
        listName: String? = nil)
    {
        self.identifier = identifier
        self.title = title
        self.dueISO = dueISO
        self.completed = completed
        self.listName = listName
    }
}

public struct CrewClawRemindersListPayload: Codable, Sendable, Equatable {
    public var reminders: [CrewClawReminderPayload]

    public init(reminders: [CrewClawReminderPayload]) {
        self.reminders = reminders
    }
}

public struct CrewClawRemindersAddPayload: Codable, Sendable, Equatable {
    public var reminder: CrewClawReminderPayload

    public init(reminder: CrewClawReminderPayload) {
        self.reminder = reminder
    }
}
