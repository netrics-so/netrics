#if DEBUG
    import SwiftUI

    /**
     * Debug builds: `-NetricsDebugWindowSizes 1376x1032,375x1032` gives the
     * iPad screen view the next size in the list (points) every
     * `-NetricsDebugStepSeconds` (default 6), at the top left of the window,
     * as a Split View, Slide Over or Stage Manager window of that size would
     * (#412). It checks re-layout on resize from a script; the device itself
     * turns from a UI test with `XCUIDevice.orientation`, since iPad windowing
     * refuses programmatic orientation changes.
     */
    struct PadDebugDriver: ViewModifier {
        private static let defaults = UserDefaults.standard
        private let sizes: [CGSize] = Self.list("NetricsDebugWindowSizes").compactMap { item in
            let sides = item.split(separator: "x").compactMap { Double($0) }
            return sides.count == 2 ? CGSize(width: sides[0], height: sides[1]) : nil
        }
        private let step: Double = {
            let seconds = Self.defaults.double(forKey: "NetricsDebugStepSeconds")
            return seconds > 0 ? seconds : 6
        }()

        @State private var index = 0

        private static func list(_ key: String) -> [String] {
            (defaults.string(forKey: key) ?? "").split(separator: ",").map {
                $0.trimmingCharacters(in: .whitespaces)
            }
        }

        func body(content: Content) -> some View {
            Group {
                if sizes.isEmpty {
                    content
                } else {
                    let size = sizes[index % sizes.count]
                    content
                        .frame(width: size.width, height: size.height)
                        .clipped()
                        .border(Color.white.opacity(0.4))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        // The window's own insets stay outside the simulated window.
                        .ignoresSafeArea()
                }
            }
            .task {
                guard !sizes.isEmpty else { return }
                while !Task.isCancelled {
                    print("netrics: debug window \(sizes[index % sizes.count])")
                    try? await Task.sleep(for: .seconds(step))
                    index += 1
                }
            }
        }
    }
#endif
