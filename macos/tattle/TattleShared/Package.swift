// swift-tools-version: 6.0
import PackageDescription

// Everything that runs without the extension or a window: rule models, the matching
// engine, the XPC protocol, the database layer, and the services the extension hosts.
// The app, the filter extension and tattlectl all link this package.
let package = Package(
    name: "TattleShared",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "TattleShared", targets: ["TattleShared"]),
        .executable(name: "tattle-bench", targets: ["TattleBenchmark"]),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0"),
    ],
    targets: [
        .target(name: "TattleShared", dependencies: [.product(name: "GRDB", package: "GRDB.swift")]),
        .executableTarget(name: "TattleBenchmark", dependencies: ["TattleShared"]),
        .testTarget(name: "TattleSharedTests", dependencies: ["TattleShared"]),
    ]
)
