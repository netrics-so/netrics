import NetricsKit
import SwiftUI

/**
 * Reached with the Siri Remote (press and hold the clickpad, or Play/Pause
 * on the dashboard; the Settings button while pairing). Shows what this TV
 * is connected to; Unpair clears the Keychain and the cache and starts
 * pairing with netrics cloud again (another server is one button away).
 */
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.screenLanguage) private var language
    let close: () -> Void
    @State private var confirmUnpair = false

    var body: some View {
        let state = model.device
        VStack(alignment: .leading, spacing: 40) {
            Text(L10n.tr("Settings", language))
                .font(.system(size: 56, weight: .semibold))
                .foregroundStyle(Theme.text)

            VStack(alignment: .leading, spacing: 22) {
                if let server = model.server {
                    Row(label: L10n.tr("Server", language), value: server.kind == .cloud ? L10n.tr("netrics cloud", language) : L10n.tr("Your own server", language))
                    if server.kind == .custom {
                        Row(label: L10n.tr("Address", language), value: server.baseURL.absoluteString)
                    }
                    Row(
                        label: L10n.tr("Insecure connections", language),
                        value: server.policy.allowInsecureConnections ? L10n.tr("On (not recommended)", language) : L10n.tr("Off", language),
                        warning: server.policy.allowInsecureConnections
                    )
                    if let pin = server.pinnedCertificateSHA256 {
                        Row(label: L10n.tr("Pinned certificate", language), value: "SHA-256 " + CertificatePinning.display(pin), small: true)
                    }
                }
                Row(label: L10n.tr("This TV", language), value: state.device?.name ?? (state.phase == .pairing ? L10n.tr("Not paired yet", language) : "—"))
                Row(label: L10n.tr("App version", language), value: AppModel.appVersion)
                if let error = state.lastError, state.offline {
                    Row(label: L10n.tr("Last error", language), value: error, small: true)
                }
            }

            Text(L10n.tr("The server can be changed only by unpairing. After unpairing, remove this TV under TVs in netrics.", language))
                .font(.system(size: 24))
                .foregroundStyle(Theme.muted)

            HStack(spacing: 40) {
                Button(L10n.tr("Done", language), action: close)
                Button(L10n.tr("Unpair this TV", language), role: .destructive) { confirmUnpair = true }
            }
        }
        .padding(.horizontal, 200)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(Theme.background)
        .onExitCommand(perform: close)
        .confirmationDialog(L10n.tr("Unpair this TV?", language), isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button(L10n.tr("Unpair", language), role: .destructive) {
                Task {
                    close()
                    await model.unpair()
                }
            }
            Button(L10n.tr("Cancel", language), role: .cancel) {}
        } message: {
            Text(L10n.tr("This TV forgets its server and credentials and shows a new pairing code for netrics cloud.", language))
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
