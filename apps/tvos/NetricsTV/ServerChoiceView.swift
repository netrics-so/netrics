import NetricsKit
import SwiftUI

/**
 * First start (ADR 0010): netrics cloud by default, or the user's own
 * server, checked with GET /v1/server before pairing.
 */
struct ServerChoiceView: View {
    @Environment(AppModel.self) private var model
    @State private var checking = false
    @State private var error: String?
    @State private var showOwnServer = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 48) {
                Spacer()
                Text("netrics")
                    .font(.system(size: 88, weight: .semibold))
                    .foregroundStyle(Theme.text)
                Text("Show your dashboards on this TV. Where are they?")
                    .font(.system(size: 34))
                    .foregroundStyle(Theme.muted)

                VStack(spacing: 28) {
                    Button {
                        Task { await connectToCloud() }
                    } label: {
                        ChoiceLabel(title: "netrics cloud", detail: "The hosted service")
                    }
                    Button {
                        showOwnServer = true
                    } label: {
                        ChoiceLabel(title: "Your own server", detail: "A self-hosted netrics server")
                    }
                }
                .disabled(checking)
                .frame(width: 900)

                StatusLine(checking: checking, error: error ?? model.storageError)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background)
            .navigationDestination(isPresented: $showOwnServer) {
                ServerEntryView()
            }
            .onAppear {
                if DebugLaunch.server != nil {
                    showOwnServer = true
                }
            }
        }
    }

    private func connectToCloud() async {
        checking = true
        error = nil
        let result = await ServerChecker.live.check(ServerConfig.cloud)
        checking = false
        switch result {
        case .success(let checked):
            model.use(checked)
        case .failure(let failure):
            error = failure.message
        }
    }
}

private struct ChoiceLabel: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 36, weight: .semibold))
            Text(detail).font(.system(size: 24)).opacity(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 12)
    }
}

private struct StatusLine: View {
    let checking: Bool
    let error: String?

    var body: some View {
        Group {
            if checking {
                HStack(spacing: 16) {
                    ProgressView()
                    Text("Checking the server…").foregroundStyle(Theme.muted)
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
    @State private var address = DebugLaunch.server ?? ""
    @State private var allowInsecure = DebugLaunch.allowInsecure
    @State private var checking = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 36) {
            Text("Your own server")
                .font(.system(size: 56, weight: .semibold))
                .foregroundStyle(Theme.text)
            Text("Enter the address of your netrics server, as you open it in a browser.")
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
                    Text("Allow insecure connections")
                        .font(.system(size: 30, weight: .medium))
                    Text(
                        "Not recommended. Allows plain HTTP to servers on your local network, and a self-signed certificate that is trusted on first use."
                    )
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
                Text("Connect").font(.system(size: 32, weight: .semibold)).padding(.horizontal, 40)
            }
            .disabled(checking || address.trimmingCharacters(in: .whitespaces).isEmpty)

            StatusLine(checking: checking, error: error)
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
            error = failure.message
        }
    }
}

/** Shown wherever the server is shown while the insecure setting is on. */
struct InsecureBadge: View {
    var body: some View {
        Text("⚠ Insecure connections allowed (not recommended)")
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
