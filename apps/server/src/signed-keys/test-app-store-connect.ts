import type {
  ConnectorFetchInit,
  ConnectorResponse,
} from "@netrics/connector-sdk";

import { decodeJwt, type TestKeyPair } from "./test-keys.js";

// Tests only: an in-memory App Store Connect that verifies the host's
// signed tokens. A team is known by its issuer ID and key; a token signed by
// another key, for another audience or expired answers Apple's 401. Error
// bodies follow Apple's ErrorResponse (see the connector's fixtures).

export interface FakeAscTeam {
  issuerId: string;
  keyId: string;
  key: TestKeyPair;
  apps: Array<{ id: string; name: string; bundleId: string }>;
  vendorNumbers: string[];
  /** "developer" keys cannot read sales reports (403). */
  role?: "sales" | "developer";
  /** A revoked key answers 401 everywhere. */
  revoked?: boolean;
}

export interface FakeAsc {
  fetch(url: string, init?: ConnectorFetchInit): Promise<ConnectorResponse>;
  requests: Array<{ url: URL; issuerId: string | undefined }>;
  /** The next answers, ahead of the normal ones. */
  failures: number[];
}

function reply(status: number, body: unknown): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: {
      "content-type": "application/json",
      "x-rate-limit": "user-hour-lim:3500;user-hour-rem:3400;",
    },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

function error(status: number, code: string, title: string, detail: string) {
  return reply(status, {
    errors: [{ status: String(status), code, title, detail }],
  });
}

export function createFakeAsc(teams: FakeAscTeam[]): FakeAsc {
  const requests: FakeAsc["requests"] = [];
  const failures: number[] = [];

  function teamOf(authorization: string | undefined): FakeAscTeam | undefined {
    const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
    if (!token) return undefined;
    for (const team of teams) {
      const decoded = decodeJwt(token, team.key.publicKey);
      const exp = Number(decoded.claims.exp);
      if (
        decoded.verifies &&
        !team.revoked &&
        decoded.header.kid === team.keyId &&
        decoded.claims.iss === team.issuerId &&
        decoded.claims.aud === "appstoreconnect-v1" &&
        exp * 1000 > Date.now() - 60_000
      ) {
        return team;
      }
    }
    return undefined;
  }

  return {
    requests,
    failures,
    async fetch(raw, init) {
      const url = new URL(raw);
      if (url.hostname !== "api.appstoreconnect.apple.com") {
        throw new Error(`fake App Store Connect refuses ${raw}`);
      }
      const team = teamOf(init?.headers?.authorization);
      requests.push({ url, issuerId: team?.issuerId });
      if (!team) {
        return error(
          401,
          "NOT_AUTHORIZED",
          "Authentication credentials are missing or invalid.",
          "Provide a properly configured and signed bearer token, and make sure that it has not expired.",
        );
      }
      const failure = failures.shift();
      if (failure !== undefined) {
        return failure === 429
          ? error(
              429,
              "RATE_LIMIT_EXCEEDED",
              "The request rate limit has been reached.",
              "We've received too many requests for this API.",
            )
          : error(
              failure,
              "UNEXPECTED_ERROR",
              "An unexpected error occurred.",
              "An unexpected error occurred on the server side.",
            );
      }
      if (url.pathname === "/v1/apps") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        return reply(200, {
          data: team.apps.slice(0, limit).map((app) => ({
            type: "apps",
            id: app.id,
            attributes: { name: app.name, bundleId: app.bundleId },
          })),
          links: {},
        });
      }
      if (url.pathname === "/v1/salesReports") {
        if ((team.role ?? "sales") !== "sales") {
          return error(
            403,
            "FORBIDDEN_ERROR",
            "This request is forbidden for security reasons",
            "The API key in use does not allow this request",
          );
        }
        if (
          !team.vendorNumbers.includes(
            url.searchParams.get("filter[vendorNumber]") ?? "",
          )
        ) {
          return reply(400, {
            errors: [
              {
                status: "400",
                code: "PARAMETER_ERROR.INVALID",
                title: "A parameter has an invalid value",
                detail: "Invalid vendor number specified. Try again.",
                source: { parameter: "filter[vendorNumber]" },
              },
            ],
          });
        }
        // No sales on the latest day: a 404 that counts as success.
        return error(
          404,
          "NOT_FOUND",
          "The request expected results but none were found",
          "There were no sales for the date specified.",
        );
      }
      return error(
        404,
        "NOT_FOUND",
        "The specified resource does not exist",
        "The path provided does not match a defined resource type.",
      );
    },
  };
}
