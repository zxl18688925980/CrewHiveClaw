// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "CrewClawKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15),
    ],
    products: [
        .library(name: "CrewClawProtocol", targets: ["CrewClawProtocol"]),
        .library(name: "CrewClawKit", targets: ["CrewClawKit"]),
        .library(name: "CrewClawChatUI", targets: ["CrewClawChatUI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/steipete/ElevenLabsKit", exact: "0.1.0"),
        .package(url: "https://github.com/gonzalezreal/textual", exact: "0.3.1"),
    ],
    targets: [
        .target(
            name: "CrewClawProtocol",
            path: "Sources/CrewClawProtocol",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "CrewClawKit",
            dependencies: [
                "CrewClawProtocol",
                .product(name: "ElevenLabsKit", package: "ElevenLabsKit"),
            ],
            path: "Sources/CrewClawKit",
            resources: [
                .process("Resources"),
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .target(
            name: "CrewClawChatUI",
            dependencies: [
                "CrewClawKit",
                .product(
                    name: "Textual",
                    package: "textual",
                    condition: .when(platforms: [.macOS, .iOS])),
            ],
            path: "Sources/CrewClawChatUI",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
            ]),
        .testTarget(
            name: "CrewClawKitTests",
            dependencies: ["CrewClawKit", "CrewClawChatUI"],
            path: "Tests/CrewClawKitTests",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency"),
                .enableExperimentalFeature("SwiftTesting"),
            ]),
    ])
