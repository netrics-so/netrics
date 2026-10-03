import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import type {
  ConnectorFetchInit,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";

/**
 * An offline stand-in for the parts of the App Store Connect API the
 * connector uses, answering with the sanitized fixtures. Each team is known
 * by the bearer tokens of its key; every other token gets Apple's 401.
 */
export interface FakeTeam {
  /** Tokens this team's key signs (any other token is refused). */
  tokens: string[];
  /** Apps listed by GET /v1/apps, in fixture-page shape. */
  appPages?: unknown[];
  vendorNumbers: string[];
  /** "sales" (Sales/Finance/Admin) reads reports; "developer" cannot. */
  role?: "sales" | "developer";
  /** The Account Holder has not accepted the current agreements. */
  agreementsMissing?: boolean;
  /** Days (YYYY-MM-DD) with sales; other days answer 404. */
  salesDays?: string[];
}

export interface FakeAppStoreConnectOptions {
  teams: FakeTeam[];
  /** Answers queued ahead of the normal ones (429s, 5xx, …). */
  failures?: Array<{
    status: number;
    fixture?: string;
    headers?: Record<string, string>;
  }>;
  /** X-Rate-Limit user-hour-rem on every answer (default 3000). */
  remaining?: number;
}

export interface FakeAppStoreConnect {
  runtime: ConnectorRuntime;
  fetch: ConnectorRuntime["fetch"];
  requests: Array<{ url: URL; init: ConnectorFetchInit | undefined }>;
}

export function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

export const SALES_REPORT_TSV = [
  "Provider\tProvider Country\tSKU\tDeveloper\tTitle\tVersion\tProduct Type Identifier\tUnits\tDeveloper Proceeds\tBegin Date\tEnd Date\tCustomer Currency\tCountry Code\tCurrency of Proceeds\tApple Identifier",
  "APPLE\tUS\tEXFIELDNOTES\tExample Developer\tExample Field Notes\t2.1\t1F\t12\t0\t09/30/2026\t09/30/2026\tUSD\tUS\tUSD\t1000000001",
].join("\n");

function gzipResponse(content: string, headers: Record<string, string>) {
  const bytes = gzipSync(content);
  return {
    status: 200,
    headers: { "content-type": "application/a-gzip", ...headers },
    text: () => new TextDecoder().decode(bytes),
    json: () => {
      throw new Error("not JSON");
    },
    bytes: () => new Uint8Array(bytes),
  } satisfies ConnectorResponse;
}

export function createFakeAppStoreConnect(
  options: FakeAppStoreConnectOptions,
): FakeAppStoreConnect {
  const failures = [...(options.failures ?? [])];
  const requests: FakeAppStoreConnect["requests"] = [];
  const rate = () => ({
    "x-rate-limit": `user-hour-lim:3500;user-hour-rem:${options.remaining ?? 3000};`,
  });

  const handle = (url: URL, init?: ConnectorFetchInit): ConnectorResponse => {
    const token = /^Bearer (.+)$/.exec(init?.headers?.authorization ?? "")?.[1];
    const team = options.teams.find((candidate) =>
      candidate.tokens.includes(token ?? ""),
    );
    if (!team) {
      return jsonResponse(401, fixture("error-unauthorized"));
    }
    const failure = failures.shift();
    if (failure) {
      return jsonResponse(
        failure.status,
        failure.fixture ? fixture(failure.fixture) : {},
        { ...rate(), ...failure.headers },
      );
    }
    if (url.pathname === "/v1/apps" && init?.method === "GET") {
      const pages = team.appPages ?? [];
      const cursor = url.searchParams.get("cursor");
      // The page whose own link carries the cursor (Apple's cursors are opaque).
      const index =
        cursor === null
          ? 0
          : pages.findIndex((page) =>
              String(
                (page as { links?: { self?: string } }).links?.self ?? "",
              ).includes(`cursor=${cursor}&`),
            );
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (limit === 1) {
        // The key probe: one app is enough.
        const first = (pages[0] ?? { data: [] }) as { data: unknown[] };
        return jsonResponse(
          200,
          { data: first.data.slice(0, 1), links: {} },
          rate(),
        );
      }
      return jsonResponse(200, pages[index] ?? { data: [] }, rate());
    }
    if (url.pathname === "/v1/salesReports" && init?.method === "GET") {
      if (team.agreementsMissing) {
        return jsonResponse(403, fixture("error-forbidden-agreements"), rate());
      }
      if ((team.role ?? "sales") !== "sales") {
        return jsonResponse(403, fixture("error-forbidden-role"), rate());
      }
      const vendor = url.searchParams.get("filter[vendorNumber]") ?? "";
      if (!team.vendorNumbers.includes(vendor)) {
        return jsonResponse(400, fixture("error-invalid-vendor"), rate());
      }
      const date = url.searchParams.get("filter[reportDate]") ?? "";
      if (!(team.salesDays ?? []).includes(date)) {
        return jsonResponse(404, fixture("error-not-found-no-sales"), rate());
      }
      return gzipResponse(SALES_REPORT_TSV, rate());
    }
    return jsonResponse(
      404,
      {
        errors: [
          {
            status: "404",
            code: "NOT_FOUND",
            title: "The specified resource does not exist",
            detail: `The path provided does not match a defined resource type.`,
          },
        ],
      },
      rate(),
    );
  };

  const fetch: ConnectorRuntime["fetch"] = async (raw, init) => {
    const url = new URL(raw);
    requests.push({ url, init });
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.appstoreconnect.apple.com"
    ) {
      throw new Error(`fake App Store Connect refuses ${raw}`);
    }
    return handle(url, init);
  };

  return {
    requests,
    fetch,
    runtime: { signal: new AbortController().signal, fetch },
  };
}
