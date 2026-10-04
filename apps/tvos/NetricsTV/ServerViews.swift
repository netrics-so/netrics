import NetricsKit
import SwiftUI

/**
 * First start (ADR 0010): the TV checks netrics cloud on its own and goes
 * straight to the pairing code. This screen only shows while the cloud does
 * not answer; it retries by itself, and offers the user's own server.
 */
struct ConnectingCloudView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.screenLanguage) private var language

    var body: some View {
        VStack(spacing: 48) {
            Spacer()
            Text("netrics")
                .font(.system(size: 88, weight: .semibold))
                .foregroundStyle(Theme.text)
            StatusLine(
                checking: model.cloudError == nil,
                checkingText: L10n.tr("Connecting to netrics cloud…", language),
                error: model.cloudError.map { "\($0.message(in: language))\n\(L10n.tr("Retrying…", language))" }
                    ?? model.storageError)
            Spacer()
            Button(L10n.tr("Use your own server", language)) { model.switchToOwnServer() }
                .font(.system(size: 24))
        }
        .padding(.vertical, 60)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
    }
}

private struct StatusLine: View {
    let checking: Bool
    let checkingText: String
    let error: String?

    var body: some View {
        Group {
            if checking {
                HStack(spacing: 16) {
                    ProgressView()
                    Text(checkingText).foregroundStyle(Theme.muted)
                }
            } else if let error {
                Text(error).foregroundStyle(Theme.down)
            } else {
                Text(" ")
            }
        }
        .font(.system(size: 28))
        .multilineTextAlignment(.center)
        .frame(maxWidth: 1400, minHeight: 90)
    }
}

/** "Your own server": the address once, and the transport setting. */
struct ServerEntryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.screenLanguage) private var language
    @State private var address = DebugLaunch.server ?? ""
    @State private var allowInsecure = DebugLaunch.allowInsecure
    @State private var checking = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 36) {
            Text(L10n.tr("Your own server", language))
                .font(.system(size: 56, weight: .semibold))
                .foregroundStyle(Theme.text)
            Text(L10n.tr("Enter the address of your netrics server, as you open it in a browser.", language))
                .font(.system(size: 30))
                .foregroundStyle(Theme.muted)

            TextField("netrics.example.com", text: $address)
                .textContentType(.URL)
                .keyboardType(.URL)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .onSubmit { Task { await check() } }

            Toggle(isOn: $allowInsecure) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L10n.tr("Allow insecure connections", language))
                        .font(.system(size: 30, weight: .medium))
                    Text(
                        L10n.tr(
                            "Not recommended. Allows plain HTTP to servers on your local network, and a self-signed certificate that is trusted on first use.",
                            language))
                    .font(.system(size: 22))
                    .multilineTextAlignment(.leading)
                    .opacity(0.7)
                }
            }

            if allowInsecure {
                InsecureBadge()
            }

            Button {
                Task { await check() }
            } label: {
                Text(L10n.tr("Connect", language)).font(.system(size: 32, weight: .semibold)).padding(.horizontal, 40)
            }
            .disabled(checking || address.trimmingCharacters(in: .whitespaces).isEmpty)

            StatusLine(checking: checking, checkingText: L10n.tr("Checking the server…", language), error: error)

            Button(L10n.tr("Use netrics cloud instead", language)) { model.switchToCloud() }
                .font(.system(size: 24))
                .disabled(checking)
        }
        .padding(.horizontal, 240)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .task {
            if DebugLaunch.autoConnect {
                try? await Task.sleep(for: .seconds(3))
                await check()
            }
        }
    }

    private func check() async {
        guard !checking else { return }
        checking = true
        error = nil
        let result = await ServerChecker.live.check(
            address: address, kind: .custom, allowInsecure: allowInsecure)
        checking = false
        switch result {
        case .success(let checked):
            model.use(checked)
        case .failure(let failure):
            error = failure.message(in: language)
        }
    }
}

/** Shown wherever the server is shown while the insecure setting is on. */
struct InsecureBadge: View {
    @Environment(\.screenLanguage) private var language

    var body: some View {
        Text(L10n.tr("⚠ Insecure connections allowed (not recommended)", language))
            .font(.system(size: 24, weight: .medium))
            .foregroundStyle(Theme.warning)
    }
}

/**
 * Debug builds only: prefill "Your own server" from launch arguments, so a
 * simulator can be driven without a remote, e.g.
 * `xcrun simctl launch <udid> tv.netrics -NetricsDebugServer http://localhost:3190
 *  -NetricsDebugInsecure YES -NetricsDebugAutoConnect YES`.
 */
enum DebugLaunch {
    #if DEBUG
        static var server: String? { UserDefaults.standard.string(forKey: "NetricsDebugServer") }
        static var allowInsecure: Bool { UserDefaults.standard.bool(forKey: "NetricsDebugInsecure") }
        static var autoConnect: Bool { UserDefaults.standard.bool(forKey: "NetricsDebugAutoConnect") }
        static var openSettings: Bool { UserDefaults.standard.bool(forKey: "NetricsDebugSettings") }
    #else
        static let server: String? = nil
        static let allowInsecure = false
        static let autoConnect = false
        static let openSettings = false
    #endif
}
