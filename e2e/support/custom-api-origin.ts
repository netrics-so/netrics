import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The custom API fixture server of the builder journey (#807): https on
 * 127.0.0.1, NETRICS_E2E_CUSTOM_API_PORT (default 3443).
 */
export const CUSTOM_API_PORT = Number(
  process.env.NETRICS_E2E_CUSTOM_API_PORT ?? 3443,
);
export const CUSTOM_API_ORIGIN = `https://127.0.0.1:${CUSTOM_API_PORT}`;

// Not under test-results/: Playwright empties that after loading the config.
const dir = fileURLToPath(
  new URL(
    "../../node_modules/.cache/netrics-e2e/custom-api-tls/",
    import.meta.url,
  ),
);
export const CUSTOM_API_TLS = {
  key: `${dir}key.pem`,
  cert: `${dir}cert.pem`,
};

/** A self-signed certificate for 127.0.0.1, made once (no key is committed). */
export function ensureCustomApiCertificate(): void {
  if (existsSync(CUSTOM_API_TLS.key) && existsSync(CUSTOM_API_TLS.cert)) return;
  mkdirSync(dir, { recursive: true });
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    CUSTOM_API_TLS.key,
    "-out",
    CUSTOM_API_TLS.cert,
  ]);
}
