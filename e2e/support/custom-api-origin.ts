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

/** The cached certificate is still valid for at least a day. */
function certificateValid(): boolean {
  if (!existsSync(CUSTOM_API_TLS.key) || !existsSync(CUSTOM_API_TLS.cert))
    return false;
  try {
    execFileSync(
      "openssl",
      ["x509", "-checkend", "86400", "-noout", "-in", CUSTOM_API_TLS.cert],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * A self-signed certificate for 127.0.0.1 (no key is committed), made again
 * when it is missing or expires within a day.
 */
export function ensureCustomApiCertificate(): void {
  if (certificateValid()) return;
  console.warn(
    `Made a new custom API test certificate (${CUSTOM_API_TLS.cert}). ` +
      "A running dev API (pnpm dev) still trusts the old one: restart it " +
      "with NODE_EXTRA_CA_CERTS set to this file.",
  );
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
    "7",
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
