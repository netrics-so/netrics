import NetricsKit
import SwiftUI

/**
 * Reached with the Siri Remote (Play/Pause, or press and hold the clickpad
 * on the dashboard; the Settings button while pairing). Shows what this TV
 * is connected to; Unpair clears the Keychain and the cache and starts
 * pairing with netrics cloud again (another server is one button away).
 */
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    let close: () -> Void
    @State private var confirmUnpair = false

    var body: some View {
        let state = model.device
        VStack(alignment: .leading, spacing: 40) {
            Text("Settings")
                .font(.system(size: 56, weight: .semibold))
                .foregroundStyle(Theme.text)

            VStack(alignment: .leading, spacing: 22) {
                if let server = model.server {
                    Row(label: "Server", value: server.kind == .cloud ? "netrics cloud" : "Your own server")
                    if server.kind == .custom {
                        Row(label: "Address", value: server.baseURL.absoluteString)
                    }
                    Row(
                        label: "Insecure connections",
                        value: server.policy.allowInsecureConnections ? "On (not recommended)" : "Off",
                        warning: server.policy.allowInsecureConnections
                    )
                    if let pin = server.pinnedCertificateSHA256 {
                        Row(label: "Pinned certificate", value: "SHA-256 " + CertificatePinning.display(pin), small: true)
                    }
                }
                Row(label: "This TV", value: state.device?.name ?? (state.phase == .pairing ? "Not paired yet" : "—"))
                Row(label: "App version", value: AppModel.appVersion)
                if let error = state.lastError, state.offline {
                    Row(label: "Last error", value: error, small: true)
                }
            }

            Text("The server can be changed only by unpairing. After unpairing, remove this TV under TVs in netrics.")
                .font(.system(size: 24))
                .foregroundStyle(Theme.muted)

            HStack(spacing: 40) {
                Button("Done", action: close)
                Button("Unpair this TV", role: .destructive) { confirmUnpair = true }
            }
        }
        .padding(.horizontal, 200)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(Theme.background)
        .onExitCommand(perform: close)
        .confirmationDialog("Unpair this TV?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) {
                Task {
                    close()
                    await model.unpair()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This TV forgets its server and credentials and shows a new pairing code for netrics cloud.")
        }
    }
}

private struct Row: View {
    let label: String
    let value: String
    var warning = false
    var small = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 40) {
            Text(label)
                .foregroundStyle(Theme.muted)
                .frame(width: 420, alignment: .leading)
            Text(value)
                .foregroundStyle(warning ? Theme.warning : Theme.text)
                .font(.system(size: small ? 22 : 30))
                .lineLimit(2)
        }
        .font(.system(size: 30))
    }
}
