import NetricsKit
import NetricsUI
import SwiftUI

/**
 * The settings sheet: what this device is connected to, the transport
 * setting, the app version, and Unpair, which revokes the device on the
 * server (#407), clears the Keychain and the cache and shows a new code for
 * netrics cloud (another server is one button away). The server and its
 * transport setting change only by unpairing, as on Apple TV.
 */
struct TouchSettingsView: View {
    @Environment(DeviceSession.self) private var model
    @Environment(\.screenLanguage) private var language
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var confirmUnpair = false
    /** Values sit right of their label; at the accessibility sizes the row stacks and they start left. */
    private var valueAlignment: TextAlignment { typeSize.isAccessibilitySize ? .leading : .trailing }

    var body: some View {
        let state = model.device
        NavigationStack {
            Form {
                if let server = model.server {
                    Section(L10n.tr("Server", language)) {
                        row(
                            L10n.tr("Server", language),
                            server.kind == .cloud
                                ? L10n.tr("netrics cloud", language) : L10n.tr("Your own server", language))
                        if server.kind == .custom {
                            row(L10n.tr("Address", language), server.baseURL.absoluteString)
                        }
                        row(
                            L10n.tr("Insecure connections", language),
                            server.policy.allowInsecureConnections
                                ? L10n.tr("On (not recommended)", language) : L10n.tr("Off", language),
                            warning: server.policy.allowInsecureConnections)
                        if let pin = server.pinnedCertificateSHA256 {
                            LabeledContent(L10n.tr("Pinned certificate", language)) {
                                Text(verbatim: "SHA-256 " + CertificatePinning.display(pin))
                                    .font(.caption.monospaced())
                                    .multilineTextAlignment(valueAlignment)
                            }
                        }
                    }
                }
                Section {
                    row(
                        L10n.tr("This device", language),
                        state.device?.name ?? (state.phase == .pairing ? L10n.tr("Not paired yet", language) : "—"))
                    row(L10n.tr("App version", language), DeviceSession.appVersion)
                    if let error = state.lastError, state.offline {
                        LabeledContent(L10n.tr("Last error", language)) {
                            Text(error).font(.footnote).multilineTextAlignment(valueAlignment)
                        }
                    }
                }
                Section {
                    Button(L10n.tr("Unpair this device", language), role: .destructive) { confirmUnpair = true }
                } footer: {
                    Text(
                        L10n.tr(
                            "The server can be changed only by unpairing. After unpairing, remove this device under TVs in netrics.",
                            language))
                }
            }
            .navigationTitle(L10n.tr("Settings", language))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.tr("Done", language)) { dismiss() }
                }
            }
            .confirmationDialog(
                L10n.tr("Unpair this device?", language), isPresented: $confirmUnpair, titleVisibility: .visible
            ) {
                Button(L10n.tr("Unpair", language), role: .destructive, action: unpair)
                Button(L10n.tr("Cancel", language), role: .cancel) {}
            } message: {
                Text(
                    L10n.tr(
                        "This device forgets its server and credentials and shows a new pairing code for netrics cloud.",
                        language))
            }
        }
    }

    private func row(_ label: String, _ value: String, warning: Bool = false) -> some View {
        LabeledContent(label) {
            Text(value)
                .foregroundStyle(warning ? Theme.warning : .secondary)
                .multilineTextAlignment(valueAlignment)
        }
    }

    private func unpair() {
        Task {
            dismiss()
            await model.unpair()
        }
    }
}
