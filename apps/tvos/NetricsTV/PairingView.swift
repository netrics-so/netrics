import NetricsKit
import SwiftUI

/**
 * The code, where to enter it (the URL the server reports, ADR 0010), and a
 * QR code of the approval link with the code filled in.
 */
struct PairingView: View {
    @Environment(AppModel.self) private var model
    let state: DeviceState
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            HStack(alignment: .center, spacing: 120) {
                VStack(alignment: .leading, spacing: 36) {
                    Text("Show a netrics dashboard on this screen")
                        .font(.system(size: 36))
                        .foregroundStyle(Theme.muted)
                    if let pairing = state.pairing {
                        Text(pairing.code)
                            .font(.system(size: 150, weight: .semibold, design: .monospaced))
                            .tracking(12)
                            .foregroundStyle(Theme.text)
                            .accessibilityLabel("Pairing code \(pairing.code)")
                        Text(
                            "Go to \(Text(PairingAddress.display(pairing.pairingUrl)).foregroundStyle(Theme.text).fontWeight(.medium)) and enter the code."
                        )
                        .foregroundStyle(Theme.muted)
                        .font(.system(size: 34))
                    } else {
                        Text("····-····")
                            .font(.system(size: 150, weight: .semibold, design: .monospaced))
                            .foregroundStyle(Theme.faint)
                    }
                    if state.offline {
                        Text("Cannot reach netrics — retrying")
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
                Button("Settings", action: openSettings)
            }
            .font(.system(size: 24))
        }
        .padding(.horizontal, 100)
        .padding(.vertical, 60)
    }
}

struct QRCodeView: View {
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
            Text("Or scan with your phone")
                .font(.system(size: 24))
                .foregroundStyle(Theme.muted)
        }
    }
}
