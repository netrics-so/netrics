import NetricsKit
import NetricsUI
import SwiftUI
import UIKit

/**
 * The code, where to enter it (the URL the server reports, ADR 0010) and a
 * QR code of the approval link, as on Apple TV. The person approving often
 * holds this device (ADR 0021, section 2), so the screen also opens the
 * approval page in Safari (the web session signs in there, never in the
 * app), shares the link with an admin and copies the code. The client keeps
 * polling; back from Safari the app polls at once and shows the dashboard.
 */
struct TouchPairingView: View {
    @Environment(DeviceSession.self) private var model
    @Environment(\.screenLanguage) private var language
    @Environment(\.openURL) private var openURL
    let state: DeviceState
    let openSettings: () -> Void
    @State private var copied = 0

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    code
                    if let pairing = state.pairing, let approve = URL(string: pairing.approveUrl) {
                        actions(pairing, approve: approve)
                        QRCodeCard(text: pairing.approveUrl)
                    }
                    if state.offline {
                        Text(L10n.tr("Cannot reach netrics — retrying", language))
                            .font(.footnote)
                            .foregroundStyle(Theme.warning)
                        if let server = model.server, server.isOnLocalNetwork {
                            LocalNetworkHint()
                        }
                    }
                    serverFooter
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 32)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(Theme.background)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L10n.tr("Settings", language), systemImage: "gearshape", action: openSettings)
                }
            }
        }
    }

    private var code: some View {
        VStack(spacing: 12) {
            Text(L10n.tr("Show a netrics dashboard on this screen", language))
                .font(.headline)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
            if let pairing = state.pairing {
                Text(pairing.code)
                    .font(.system(size: 52, weight: .semibold, design: .monospaced))
                    .minimumScaleFactor(0.5)
                    .lineLimit(1)
                    .foregroundStyle(Theme.text)
                    .textSelection(.enabled)
                    .accessibilityLabel(L10n.tr("Pairing code %@", language, pairing.code))
                goTo(PairingAddress.display(pairing.pairingUrl))
                    .font(.body)
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
            } else {
                Text(verbatim: "····-····")
                    .font(.system(size: 52, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Theme.faint)
                    .accessibilityHidden(true)
                ProgressView()
            }
        }
    }

    private func actions(_ pairing: PairingDisplay, approve: URL) -> some View {
        VStack(spacing: 12) {
            Button {
                openURL(approve)
            } label: {
                Label(L10n.tr("Open approval page", language), systemImage: "safari")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            HStack(spacing: 12) {
                ShareLink(item: approve) {
                    Label(L10n.tr("Share link", language), systemImage: "square.and.arrow.up")
                        .frame(maxWidth: .infinity)
                }
                let done = copied > 0
                Button {
                    UIPasteboard.general.string = pairing.code
                    copied += 1
                } label: {
                    Label(
                        L10n.tr(done ? "Code copied" : "Copy code", language),
                        systemImage: done ? "checkmark" : "doc.on.doc"
                    )
                    .frame(maxWidth: .infinity)
                }
                .sensoryFeedback(.success, trigger: copied)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            // German labels are longer: one line each, a little smaller if needed.
            .lineLimit(1)
            .minimumScaleFactor(0.75)

            Text(
                L10n.tr(
                    "Approving on this device? Open the approval page, approve as an owner or admin, then come back here: the dashboard appears on its own.",
                    language)
            )
            .font(.footnote)
            .foregroundStyle(Theme.muted)
            .multilineTextAlignment(.center)
        }
        .task(id: copied) {
            // "Code copied" for a moment, then the button again.
            guard copied > 0 else { return }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { copied = 0 }
        }
    }

    private var serverFooter: some View {
        VStack(spacing: 10) {
            if let server = model.server {
                Text(server.displayName)
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
                if server.policy.allowInsecureConnections {
                    TouchInsecureBadge()
                }
            }
            if model.server?.kind == .cloud {
                Button(L10n.tr("Use your own server", language)) { model.switchToOwnServer() }
            } else {
                Button(L10n.tr("Use netrics cloud", language)) { model.switchToCloud() }
            }
        }
        .padding(.top, 8)
    }

    /** "Go to <address> and enter the code.", the address emphasised, in the device's language. */
    private func goTo(_ address: String) -> Text {
        let sentence = L10n.tr("Go to %@ and enter the code.", language)
        let parts = sentence.components(separatedBy: "%@")
        let emphasised = Text(address).foregroundStyle(Theme.text).fontWeight(.medium)
        guard parts.count == 2 else { return Text(sentence.replacingOccurrences(of: "%@", with: address)) }
        return Text("\(Text(parts[0]))\(emphasised)\(Text(parts[1]))")
    }
}

/** The approval link as a QR code, for another phone or tablet to scan. */
struct QRCodeCard: View {
    @Environment(\.screenLanguage) private var language
    let text: String

    var body: some View {
        VStack(spacing: 10) {
            if let image = QRCode.image(for: text) {
                Image(decorative: image, scale: 1)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 180, height: 180)
                    .padding(14)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            Text(L10n.tr("Or scan with another device", language))
                .font(.footnote)
                .foregroundStyle(Theme.muted)
        }
    }
}

/** Shown wherever the server is shown while the insecure setting is on. */
struct TouchInsecureBadge: View {
    @Environment(\.screenLanguage) private var language

    var body: some View {
        Label(
            L10n.tr("Insecure connections allowed (not recommended)", language),
            systemImage: "exclamationmark.triangle.fill"
        )
        .font(.footnote.weight(.medium))
        .foregroundStyle(Theme.warning)
    }
}

/**
 * iOS asks before the app reaches a local host, and never says when access
 * was denied: requests just fail. When a server on the local network does
 * not answer, explain where the setting is (ADR 0021, section 2).
 */
struct LocalNetworkHint: View {
    @Environment(\.screenLanguage) private var language
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(L10n.tr("Local network access", language), systemImage: "network")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.text)
            Text(
                L10n.tr(
                    "netrics TV needs access to your local network to reach a server there. If you did not allow it, turn on Local Network for netrics TV in Settings.",
                    language)
            )
            .font(.footnote)
            .foregroundStyle(Theme.muted)
            Button(L10n.tr("Open Settings", language)) {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
            }
            .font(.footnote.weight(.medium))
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.tile, in: RoundedRectangle(cornerRadius: 12))
    }
}

extension ServerConfig {
    /** A server on the local network: iOS's Local Network permission applies. */
    var isOnLocalNetwork: Bool {
        baseURL.host().map(HostClassifier.isLocalNetwork) ?? false
    }
}
