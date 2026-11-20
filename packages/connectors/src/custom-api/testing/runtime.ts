// A ConnectorRuntime for custom-api package tests. The connectors package
// may not import connector-runtime (PACKAGE_LAYERS), so this enforces the
// parts of the host's egress guard the tests rely on itself: http(s) only,
// listed hosts only, no automatic redirects, a bounded body.

import type {
  ConnectorFetchInit,
  ConnectorLogger,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** globalThis.fetch with redirect "manual", only to `allowedHosts` (host names), bounded body. */
export function fixtureRuntime(
  allowedHosts: readonly string[],
  options: { log?: ConnectorLogger } = {},
): ConnectorRuntime {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    ...(options.log ? { log: options.log } : {}),
    async fetch(
      raw: string,
      init: ConnectorFetchInit = {},
    ): Promise<ConnectorResponse> {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("fixture runtime: only http(s)");
      if (url.username || url.password)
        throw new Error("fixture runtime: credentials in URL");
      if (!allowedHosts.includes(url.hostname))
        throw new Error(`fixture runtime: ${url.hostname} is not allowed`);
      const response = await fetch(url, {
        method: init.method ?? "GET",
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: "manual",
        signal: controller.signal,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES)
        throw new Error("fixture runtime: response too large");
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const text = new TextDecoder().decode(bytes);
      return {
        status: response.status,
        headers,
        text: () => text,
        json: () => JSON.parse(text) as unknown,
        bytes: () => new Uint8Array(bytes),
      };
    },
  };
}
