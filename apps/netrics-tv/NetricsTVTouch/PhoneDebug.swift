#if DEBUG
    import SwiftUI
    import UIKit

    /**
     * Debug builds: `-NetricsDebugOrientations landscape,portrait` turns the
     * iPhone's window to the next orientation in the list every
     * `-NetricsDebugStepSeconds` (default 6), as turning the phone would
     * (#413). `simctl` cannot turn a simulator; iPhone scenes accept
     * `requestGeometryUpdate`, so the switch between scroll and screen view
     * is checked from a script.
     */
    struct PhoneDebugDriver: ViewModifier {
        private static let defaults = UserDefaults.standard
        private let orientations: [UIInterfaceOrientationMask] =
            (defaults.string(forKey: "NetricsDebugOrientations") ?? "").split(separator: ",").compactMap {
                switch $0.trimmingCharacters(in: .whitespaces) {
                case "portrait": return .portrait
                case "landscape": return .landscapeRight
                default: return nil
                }
            }
        private let step: Double = {
            let seconds = defaults.double(forKey: "NetricsDebugStepSeconds")
            return seconds > 0 ? seconds : 6
        }()

        func body(content: Content) -> some View {
            content.task {
                guard !orientations.isEmpty else { return }
                var index = 0
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(step))
                    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
                    let mask = orientations[index % orientations.count]
                    print("netrics: debug orientation \(mask == .portrait ? "portrait" : "landscape")")
                    scene?.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
                        print("netrics: debug orientation refused: \(error)")
                    }
                    index += 1
                }
            }
        }
    }
#endif
