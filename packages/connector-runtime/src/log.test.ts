import type {
  ConnectionContext,
  Connector,
  ConnectorLogFields,
  ConnectorRuntime,
} from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import { demoManifest } from "@netrics/connectors";

import { executeCheck, executeSync } from "./execute.js";
import {
  CONNECTOR_LOG_MAX_FIELDS,
  CONNECTOR_LOG_MAX_LINES,
  CONNECTOR_LOG_MAX_STRING,
  createConnectorLogger,
  type ConnectorLogEntry,
} from "./log.js";

const TOKEN = "tok_live_9f8e7d6c5b4a";
const JWT =
  "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ0ZWFtIiwiZXhwIjoxfQ.c2lnbmF0dXJlLWJ5dGVz";

function logger(credentials: Record<string, unknown> = {}) {
  const entries: ConnectorLogEntry[] = [];
  let active = true;
  const log = createConnectorLogger({
    connectorId: "demo",
    credentials,
    sink: (entry) => entries.push(entry),
    active: () => active,
  });
  return { log, entries, end: () => (active = false) };
}

describe("createConnectorLogger", () => {
  it("passes level, message and scalar fields with the connector id", () => {
    const { log, entries } = logger();
    log.debug("d");
    log.info("report not published yet", { app: "123", day: "2026-11-15" });
    log.warn("w", { count: 3, late: true, none: null });
    log.error("e");
    expect(entries).toEqual([
      { level: "debug", connector: "demo", message: "d", fields: {} },
      {
        level: "info",
        connector: "demo",
        message: "report not published yet",
        fields: { app: "123", day: "2026-11-15" },
      },
      {
        level: "warn",
        connector: "demo",
        message: "w",
        fields: { count: 3, late: true, none: null },
      },
      { level: "error", connector: "demo", message: "e", fields: {} },
    ]);
  });

  it("redacts fields whose name looks secret-like", () => {
    const { log, entries } = logger();
    log.info("m", {
      accessToken: "abc",
      apiKey: "abc",
      client_secret: "abc",
      password: "abc",
      Authorization: "abc",
      cookie: "abc",
      credentials: "abc",
      app: "123",
    });
    expect(entries[0]!.fields).toEqual({
      accessToken: "[redacted]",
      apiKey: "[redacted]",
      client_secret: "[redacted]",
      password: "[redacted]",
      Authorization: "[redacted]",
      cookie: "[redacted]",
      credentials: "[redacted]",
      app: "123",
    });
  });

  it("strips the connection's credential values from messages and fields", () => {
    const { log, entries } = logger({ accessToken: TOKEN });
    log.warn(`provider refused ${TOKEN}`, { detail: `sent ${TOKEN}` });
    const line = JSON.stringify(entries);
    expect(line).not.toContain(TOKEN);
    expect(entries[0]!.message).toBe("provider refused [redacted]");
    expect(entries[0]!.fields).toEqual({ detail: "sent [redacted]" });
  });

  it("drops fields whose name carries a credential value or a JWT", () => {
    const secret = "sk-live-logging-token-456";
    const { log, entries } = logger({ token: secret });
    log.warn("m", {
      [secret]: "rejected",
      [`app_${secret}`]: "rejected",
      [JWT]: "rejected",
      app: "123",
    });
    expect(entries[0]!.fields).toEqual({ app: "123" });
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(JSON.stringify(entries)).not.toContain(JWT);
  });

  it("redacts bearer values, JWTs and PEM blocks it does not know", () => {
    const { log, entries } = logger();
    log.info(`Authorization: Bearer ${"a".repeat(40)}`, {
      detail: `token ${JWT} rejected`,
      pem: "-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----",
    });
    const line = JSON.stringify(entries);
    expect(line).not.toContain("a".repeat(40));
    expect(line).not.toContain(JWT);
    expect(line).not.toContain("MIGT");
    expect(entries[0]!.message).toBe("Authorization: [redacted]");
    expect(entries[0]!.fields.detail).toBe("token [redacted] rejected");
  });

  it("refuses non-scalar fields and malformed field names", () => {
    const { log, entries } = logger({ accessToken: TOKEN });
    log.info("m", {
      record: { accessToken: TOKEN },
      rows: [TOKEN],
      "bad name": "x",
      fn: (() => TOKEN) as unknown as string,
      ok: "y",
    } as unknown as ConnectorLogFields);
    expect(entries[0]!.fields).toEqual({ ok: "y" });
    // Not fields at all: an array or a string in place of the object.
    log.info("m", ["x"] as unknown as ConnectorLogFields);
    log.info("m", "x" as unknown as ConnectorLogFields);
    expect(entries[1]!.fields).toEqual({});
    expect(entries[2]!.fields).toEqual({});
  });

  it("truncates long strings and bounds fields and lines", () => {
    const { log, entries } = logger();
    const fields = Object.fromEntries(
      Array.from({ length: CONNECTOR_LOG_MAX_FIELDS + 5 }, (_, i) => [
        `f${i}`,
        i,
      ]),
    );
    log.info("x".repeat(CONNECTOR_LOG_MAX_STRING * 2), fields);
    expect(entries[0]!.message).toHaveLength(CONNECTOR_LOG_MAX_STRING + 1);
    expect(Object.keys(entries[0]!.fields)).toHaveLength(
      CONNECTOR_LOG_MAX_FIELDS,
    );
    for (let i = 0; i < CONNECTOR_LOG_MAX_LINES + 10; i += 1) log.info("m");
    expect(entries).toHaveLength(CONNECTOR_LOG_MAX_LINES + 1);
    expect(entries.at(-1)!.message).toMatch(/log limit/);
  });

  it("drops lines after the call ended and never throws", () => {
    const { log, entries, end } = logger();
    end();
    log.info("late");
    expect(entries).toEqual([]);
    const throwing = createConnectorLogger({
      connectorId: "demo",
      credentials: {},
      sink: () => {
        throw new Error("sink down");
      },
      active: () => true,
    });
    expect(() => throwing.warn("m")).not.toThrow();
    const silent = createConnectorLogger({
      connectorId: "demo",
      credentials: {},
      sink: undefined,
      active: () => true,
    });
    expect(() => silent.info("m")).not.toThrow();
  });
});

describe("runtime.log in connector calls", () => {
  const context: ConnectionContext = {
    connectionId: "conn-1",
    config: {},
    credentials: { accessToken: TOKEN },
  };

  function loggingConnector(
    onRuntime?: (runtime: ConnectorRuntime) => void,
  ): Connector {
    return {
      manifest: demoManifest,
      async check(callContext, runtime) {
        runtime.log?.warn("checked", {
          accessToken: String(callContext.credentials.accessToken),
        });
        return { ok: true };
      },
      async discover() {
        return [];
      },
      async sync(callContext, _request, runtime) {
        onRuntime?.(runtime);
        runtime.log?.info(
          `day kept pending with ${String(callContext.credentials.accessToken)}`,
          { day: "2024-01-01" },
        );
        return { observations: [], done: true };
      },
    };
  }

  it("hands every call a logger whose lines reach the host's sink redacted", async () => {
    const entries: ConnectorLogEntry[] = [];
    let kept: ConnectorRuntime | undefined;
    await executeSync(
      loggingConnector((runtime) => (kept = runtime)),
      context,
      {
        mode: "incremental",
        from: "2024-01-01T00:00:00.000Z",
        to: "2024-01-02T00:00:00.000Z",
      },
      { log: (entry) => entries.push(entry) },
    );
    await executeCheck(loggingConnector(), context, {
      log: (entry) => entries.push(entry),
    });
    expect(entries).toEqual([
      {
        level: "info",
        connector: "demo",
        message: "day kept pending with [redacted]",
        fields: { day: "2024-01-01" },
      },
      {
        level: "warn",
        connector: "demo",
        message: "checked",
        fields: { accessToken: "[redacted]" },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain(TOKEN);
    // A runtime retained past its call logs nothing.
    kept!.log!.info("after the call");
    expect(entries).toHaveLength(2);
  });

  it("drops connector log lines when the host passes no sink", async () => {
    await expect(
      executeSync(loggingConnector(), context, {
        mode: "incremental",
        from: "2024-01-01T00:00:00.000Z",
        to: "2024-01-02T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ done: true });
  });
});
