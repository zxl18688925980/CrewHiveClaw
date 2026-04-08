// swift-tools-version: 6.2
// Package manifest for the CrewClaw macOS companion (menu bar app + IPC library).

import PackageDescription

let package = Package(
    name: "CrewClaw",
    platforms: [
        .macOS(.v15),
    ],
    products: [
        .library(name: "CrewClawIPC", targets: ["CrewClawIPC"]),
        .library(name: "CrewClawDiscovery", targets: ["CrewClawDiscovery"]),
        .executable(name: "CrewClaw", targets: ["CrewClaw"]),
        .executable(name: "openclaw-mac", targets: ["CrewClawMacCLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/orchetect/MenuBarExtraAccess", exact: "1.2.2"),
        .package(url: "https://github.com/swiftlang/swift-subprocess.git", from: "0.1.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.8.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.8.1"),
        .package(url: "https://github.com/steipete/Peekaboo.git", branch: "main"),
        .package(path: "../shared/CrewClawKit"),
        .package(path: "../../Swabble"),
    ],
    targets: [
        .target(
            name: "CrewClawIPC",
            dependencies: [],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "CrewClawDiscovery",
            dependencies: [
                .product(name: "CrewClawKit", package: "CrewClawKit"),
            ],
            path: "Sources/CrewClawDiscovery",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "CrewClaw",
            dependencies: [
                "CrewClawIPC",
                "CrewClawDiscovery",
                .product(name: "CrewClawKit", package: "CrewClawKit"),
                .product(name: "CrewClawChatUI", package: "CrewClawKit"),
                .product(name: "CrewClawProtocol", package: "CrewClawKit"),
                .product(name: "SwabbleKit", package: "swabble"),
                .product(name: "MenuBarExtraAccess", package: "MenuBarExtraAccess"),
                .product(name: "Subprocess", package: "swift-subprocess"),
                .product(name: "Logging", package: "swift-log"),
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "PeekabooBridge", package: "Peekaboo"),
                .product(name: "PeekabooAutomationKit", package: "Peekaboo"),
            ],
            exclude: [
                "Resources/Info.plist",
            ],
            resources: [
                .copy("Resources/CrewClaw.icns"),
                .copy("Resources/DeviceModels"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .executableTarget(
            name: "CrewClawMacCLI",
            dependencies: [
                "CrewClawDiscovery",
                .product(name: "CrewClawKit", package: "CrewClawKit"),
                .product(name: "CrewClawProtocol", package: "CrewClawKit"),
            ],
            path: "Sources/CrewClawMacCLI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "CrewClawIPCTests",
            dependencies: [
                "CrewClawIPC",
                "CrewClaw",
                "CrewClawDiscovery",
                .product(name: "CrewClawProtocol", package: "CrewClawKit"),
                .product(name: "SwabbleKit", package: "swabble"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
