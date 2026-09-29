// swift-tools-version: 6.0
// NetricsKit: the tvOS app's protocol and formatting logic, without UI.
// It builds for macOS too, so `swift test` runs on a Mac.
import PackageDescription

let package = Package(
    name: "NetricsKit",
    platforms: [.tvOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "NetricsKit", targets: ["NetricsKit"]),
    ],
    targets: [
        .target(name: "NetricsKit"),
        .testTarget(name: "NetricsKitTests", dependencies: ["NetricsKit"]),
    ]
)
