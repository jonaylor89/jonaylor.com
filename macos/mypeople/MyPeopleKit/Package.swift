// swift-tools-version: 6.0
import PackageDescription

// Everything that can be tested without a window: the engine client, the published view's
// models, and the screen logic ported from Android's Logic.kt.
let package = Package(
    name: "MyPeopleKit",
    platforms: [.macOS(.v15)],
    products: [.library(name: "MyPeopleKit", targets: ["MyPeopleKit"])],
    targets: [
        .target(name: "MyPeopleKit"),
        .testTarget(name: "MyPeopleKitTests", dependencies: ["MyPeopleKit"], resources: [.copy("Fixtures")]),
    ]
)
