import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { fixtureResponse, gzipFixtureResponse } from "./index.js";

describe("fixture responses", () => {
  it("serves text, JSON and the exact bytes of a body", () => {
    const response = fixtureResponse(200, '{"name":"Zürich"}', {
      "content-type": "application/json",
    });
    expect(response.status).toBe(200);
    expect(response.text()).toBe('{"name":"Zürich"}');
    expect(response.json()).toEqual({ name: "Zürich" });
    expect([...response.bytes()]).toEqual([
      ...new TextEncoder().encode('{"name":"Zürich"}'),
    ]);
  });

  it("hands out a copy of the bytes on every call", () => {
    const response = fixtureResponse(200, new Uint8Array([1, 2, 3]));
    response.bytes().fill(0);
    expect([...response.bytes()]).toEqual([1, 2, 3]);
  });

  it("builds gzip report responses that inflate to their content", () => {
    const report = "Apple Identifier\tUnits\n123\t4\n";
    const response = gzipFixtureResponse(200, report);
    expect(response.headers["content-type"]).toBe("application/a-gzip");
    const bytes = response.bytes();
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    expect(gunzipSync(bytes).toString("utf8")).toBe(report);
  });
});
