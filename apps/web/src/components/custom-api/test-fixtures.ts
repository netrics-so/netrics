// Fixtures for the custom API builder's tests (#807).

import type { CustomApiDraft, CustomApiTestResponse } from "@netrics/contracts";

export const W = "11111111-1111-4111-8111-111111111111";
export const D = "22222222-2222-4222-8222-222222222222";

export const DRAFT: CustomApiDraft = {
  id: D,
  expiresAt: "2026-11-22T10:00:00.000Z",
  environmentId: "production",
  variables: {},
  secretsSet: ["token"],
  credentialHosts: ["api.example.test"],
};

export const TEST_RESPONSE: CustomApiTestResponse = {
  ok: true,
  truncated: false,
  error: null,
  response: {
    status: 200,
    contentType: "application/json",
    body: { data: [{ date: "2026-11-01", orders: 1 }] },
    truncated: false,
    bytes: 42,
  },
  recordArrays: [{ path: "data", length: 1 }],
  records: { path: "", count: 1, found: true },
  suggestions: [],
  rows: [],
  mapping: { skipped: 0, nulled: {} },
  log: [
    {
      page: 1,
      method: "GET",
      url: "https://api.example.test/stats",
      status: 200,
      durationMs: 12,
      bytes: 42,
      records: 1,
    },
  ],
  stopped: "end",
  window: null,
  draft: DRAFT,
};
