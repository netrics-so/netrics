import NetricsKit
import SwiftUI

/**
 * The code, where to enter it (the URL the server reports, ADR 0010), and a
 * QR code of the approval link with the code filled in.
 */
struct PairingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.screenLanguage) private var language
    let state: DeviceState
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            HStack(alignment: .center, spacing: 120) {
                VStack(alignment: .leading, spacing: 36) {
                    Text(L10n.tr("Show a netrics dashboard on this screen", language))
                        .font(.system(size: 36))
                        .foregroundStyle(Theme.muted)
                    if let pairing = state.pairing {
                        Text(pairing.code)
                            .font(.system(size: 150, weight: .semibold, design: .monospaced))
                            .tracking(12)
                            .foregroundStyle(Theme.text)
                            .accessibilityLabel(L10n.tr("Pairing code %@", language, pairing.code))
                        goTo(PairingAddress.display(pairing.pairingUrl))
                        .foregroundStyle(Theme.muted)
                        .font(.system(size: 34))
                    } else {
                        Text("····-····")
                            .font(.system(size: 150, weight: .semibold, design: .monospaced))
                            .foregroundStyle(Theme.faint)
                    }
                    if state.offline {
                        Text(L10n.tr("Cannot reach netrics — retrying", language))
                            .font(.system(size: 26))
                            .foregroundStyle(Theme.warning)
                    }
                }
                if let pairing = state.pairing {
                    QRCodeView(text: pairing.approveUrl)
                }
            }
            Spacer()
            HStack(spacing: 40) {
                if let server = model.server {
                    Text(server.displayName).foregroundStyle(Theme.muted)
                    if server.policy.allowInsecureConnections {
                        InsecureBadge()
                    }
                }
                Spacer()
                if model.server?.kind == .cloud {
                    Button(L10n.tr("Use your own server", language)) { model.switchToOwnServer() }
                } else {
                    Button(L10n.tr("Use netrics cloud", language)) { model.switchToCloud() }
                }
                Button(L10n.tr("Settings", language), action: openSettings)
            }
            .font(.system(size: 24))
        }
        .padding(.horizontal, 100)
        .padding(.vertical, 60)
    }

    /** "Go to <address> and enter the code.", the address emphasised, in the TV's language. */
    private func goTo(_ address: String) -> Text {
        let sentence = L10n.tr("Go to %@ and enter the code.", language)
        let parts = sentence.components(separatedBy: "%@")
        let emphasised = Text(address).foregroundStyle(Theme.text).fontWeight(.medium)
        guard parts.count == 2 else { return Text(sentence.replacingOccurrences(of: "%@", with: address)) }
        return Text("\(Text(parts[0]))\(emphasised)\(Text(parts[1]))")
    }
}

struct QRCodeView: View {
    @Environment(\.screenLanguage) private var language
    let text: String

    var body: some View {
        VStack(spacing: 20) {
            if let image = QRCode.image(for: text) {
                Image(decorative: image, scale: 1)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 400, height: 400)
                    .padding(24)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
            }
            Text(L10n.tr("Or scan with your phone", language))
                .font(.system(size: 24))
                .foregroundStyle(Theme.muted)
        }
    }
}
