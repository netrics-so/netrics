import NetricsKit
import NetricsUI
import SwiftUI

/**
 * First start (ADR 0010): the app checks netrics cloud on its own and goes
 * straight to the pairing code. This screen only shows while the cloud does
 * not answer; it retries by itself, and offers the user's own server.
 */
struct TouchConnectingCloudView: View {
    @Environment(DeviceSession.self) private var model
    @Environment(\.screenLanguage) private var language

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text(verbatim: "netrics TV")
                .font(.largeTitle.weight(.semibold))
                .foregroundStyle(Theme.text)
            if let error = model.cloudError {
                Text("\(error.message(in: language))\n\(L10n.tr("Retrying…", language))")
                    .foregroundStyle(Theme.down)
                    .multilineTextAlignment(.center)
            } else {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(L10n.tr("Connecting to netrics cloud…", language)).foregroundStyle(Theme.muted)
                }
            }
            if let storage = model.storageError {
                Text(storage).font(.footnote).foregroundStyle(Theme.down)
            }
            Spacer()
            Button(L10n.tr("Use your own server", language)) { model.switchToOwnServer() }
        }
        .padding(32)
        .frame(maxWidth: 560)
    }
}

/** "Your own server": the address once, and the transport setting. */
struct TouchServerEntryView: View {
    @Environment(DeviceSession.self) private var model
    @Environment(\.screenLanguage) private var language
    @State private var address = DebugLaunch.server ?? ""
    @State private var allowInsecure = DebugLaunch.allowInsecure
    @State private var checking = false
    @State private var error: ServerCheckError?
    @FocusState private var addressFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(text: $address, prompt: Text(verbatim: "netrics.example.com")) {
                        Text(L10n.tr("Address", language))
                    }
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .submitLabel(.go)
                    .focused($addressFocused)
                    .onSubmit { Task { await check() } }
                } footer: {
                    Text(L10n.tr("Enter the address of your netrics server, as you open it in a browser.", language))
                }

                Section {
                    Toggle(L10n.tr("Allow insecure connections", language), isOn: $allowInsecure)
                    if allowInsecure {
                        TouchInsecureBadge()
                    }
                } footer: {
                    Text(
                        L10n.tr(
                            "Not recommended. Allows plain HTTP to servers on your local network, and a self-signed certificate that is trusted on first use.",
                            language))
                }

                Section {
                    Button {
                        Task { await check() }
                    } label: {
                        HStack {
                            Text(L10n.tr("Connect", language)).fontWeight(.semibold)
                            if checking {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(checking || address.trimmingCharacters(in: .whitespaces).isEmpty)
                } footer: {
                    if checking {
                        Text(L10n.tr("Checking the server…", language))
                    } else if let error {
                        Text(error.message(in: language)).foregroundStyle(Theme.down)
                    }
                }

                if let error, localNetworkMayBeDenied(error) {
                    Section {
                        LocalNetworkHint()
                            .listRowInsets(EdgeInsets())
                    }
                }

                Section {
                    Button(L10n.tr("Use netrics cloud instead", language)) { model.switchToCloud() }
                        .disabled(checking)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle(L10n.tr("Your own server", language))
        }
        .task {
            if DebugLaunch.autoConnect {
                try? await Task.sleep(for: .seconds(2))
                await check()
            } else if address.isEmpty {
                addressFocused = true
            }
        }
    }

    /** A local server that does not answer: perhaps Local Network access is off. */
    private func localNetworkMayBeDenied(_ error: ServerCheckError) -> Bool {
        switch error {
        case .unreachable, .timedOut:
            return ServerAddress.parse(address)?.host().map(HostClassifier.isLocalNetwork) ?? false
        default:
            return false
        }
    }

    private func check() async {
        guard !checking else { return }
        checking = true
        error = nil
        addressFocused = false
        error = await model.checkOwnServer(address: address, allowInsecure: allowInsecure)
        checking = false
    }
}
