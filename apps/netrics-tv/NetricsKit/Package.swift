// swift-tools-version: 6.4
// NetricsKit: netrics TV's protocol and formatting logic, without UI.
// NetricsUI: the SwiftUI rendering the tvOS and iOS apps share (widgets,
// Signal design, slide canvas and chrome, scroll view, the app's strings).
// Both build for macOS too, so `swift test` runs on a Mac.
import PackageDescription

let package = Package(
    name: "NetricsKit",
    defaultLocalization: "en",
    platforms: [.tvOS(.v26), .iOS(.v27), .macOS(.v26)],
    products: [
        .library(name: "NetricsKit", targets: ["NetricsKit"]),
        .library(name: "NetricsUI", targets: ["NetricsUI"]),
    ],
    targets: [
        // Each library carries its privacy manifest (#417), which the apps' privacy report lists.
        .target(name: "NetricsKit", resources: [.copy("PrivacyInfo.xcprivacy")]),
        .target(
            name: "NetricsUI", dependencies: ["NetricsKit"],
            resources: [.process("Resources"), .copy("PrivacyInfo.xcprivacy")]),
        .testTarget(name: "NetricsKitTests", dependencies: ["NetricsKit"]),
        .testTarget(name: "NetricsUITests", dependencies: ["NetricsUI", "NetricsKit"]),
    ]
)
