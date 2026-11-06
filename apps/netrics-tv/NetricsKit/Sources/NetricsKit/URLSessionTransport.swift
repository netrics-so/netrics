import CryptoKit
import Foundation
import Security
import Synchronization

/**
 * The certificate trust for one server: its pin (SHA-256 of the leaf
 * certificate), whether self-signed certificates may be pinned, and whether
 * this is the server check (the only time a pin is learned).
 */
public final class CertificateTrust: Sendable {
    private struct State {
        var pinned: String?
        var lastRejection: TrustDecision?
    }

    private let state: Mutex<State>
    public let allowSelfSigned: Bool
    public let pinOnFirstUse: Bool

    public init(pinned: String?, allowSelfSigned: Bool, pinOnFirstUse: Bool) {
        self.state = Mutex(State(pinned: pinned.map(CertificatePinning.normalize), lastRejection: nil))
        self.allowSelfSigned = allowSelfSigned
        self.pinOnFirstUse = pinOnFirstUse
    }

    /** The pinned certificate, including one learned during this session. */
    public var pinned: String? { state.withLock { $0.pinned } }

    var lastRejection: TrustDecision? { state.withLock { $0.lastRejection } }

    /** Evaluates a server's certificate chain (URLSession challenge). */
    func evaluate(_ trust: SecTrust) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        let systemTrusted = SecTrustEvaluateWithError(trust, nil)
        let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
        let fingerprint = leaf.map { certificate in
            let data = SecCertificateCopyData(certificate) as Data
            return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        }
        return state.withLock { state in
            let decision = CertificatePinning.decide(
                systemTrusted: systemTrusted,
                leafSHA256: fingerprint,
                pinned: state.pinned,
                allowSelfSigned: allowSelfSigned,
                pinOnFirstUse: pinOnFirstUse
            )
            switch decision {
            case .useSystemTrust:
                state.lastRejection = nil
                return (.performDefaultHandling, nil)
            case .acceptPinned:
                state.lastRejection = nil
                return (.useCredential, URLCredential(trust: trust))
            case .acceptAndPin(let pin):
                state.pinned = pin
                state.lastRejection = nil
                return (.useCredential, URLCredential(trust: trust))
            case .rejectUntrusted, .rejectChanged:
                state.lastRejection = decision
                return (.cancelAuthenticationChallenge, nil)
            }
        }
    }
}

/** URLSession behind HTTPTransport: no cache, no cookies, 15 s timeout, no redirects. */
public final class URLSessionTransport: HTTPTransport {
    public static let requestTimeout: TimeInterval = 15

    private let session: URLSession
    private let policy: TransportPolicy
    public let trust: CertificateTrust

    public init(policy: TransportPolicy, trust: CertificateTrust) {
        self.policy = policy
        self.trust = trust
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = Self.requestTimeout
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.waitsForConnectivity = false
        self.session = URLSession(
            configuration: configuration,
            delegate: SessionDelegate(trust: trust),
            delegateQueue: nil
        )
    }

    deinit {
        session.finishTasksAndInvalidate()
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        try policy.validate(request.url)
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        urlRequest.timeoutInterval = Self.requestTimeout
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        do {
            let (data, response) = try await session.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse else {
                throw TransportError.unreachable("not an HTTP response")
            }
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                if let key = key as? String, let value = value as? String {
                    headers[key.lowercased()] = value
                }
            }
            return HTTPResponse(status: http.statusCode, headers: headers, body: data)
        } catch let error as TransportError {
            throw error
        } catch let error as URLError {
            throw map(error, host: request.url.host() ?? "")
        } catch {
            throw TransportError.unreachable(error.localizedDescription)
        }
    }

    private func map(_ error: URLError, host: String) -> TransportError {
        switch error.code {
        case .timedOut:
            return .timedOut
        case .cancelled, .serverCertificateUntrusted, .serverCertificateHasBadDate,
            .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot,
            .secureConnectionFailed:
            switch trust.lastRejection {
            case .rejectChanged:
                return .certificateChanged
            case .rejectUntrusted:
                return .untrustedCertificate("self-signed or not valid for \(host)")
            default:
                if error.code == .cancelled {
                    return .unreachable(error.localizedDescription)
                }
                return .untrustedCertificate(error.localizedDescription)
            }
        case .appTransportSecurityRequiresSecureConnection:
            return .plainHTTPNotAllowed(host)
        default:
            return .unreachable(error.localizedDescription)
        }
    }
}

private final class SessionDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    let trust: CertificateTrust

    init(trust: CertificateTrust) {
        self.trust = trust
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
            let serverTrust = challenge.protectionSpace.serverTrust
        else {
            return (.performDefaultHandling, nil)
        }
        return trust.evaluate(serverTrust)
    }

    // The device API never redirects; following one could leave the policy
    // (HTTPS → HTTP, or another host). The 3xx comes back as the response.
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}
