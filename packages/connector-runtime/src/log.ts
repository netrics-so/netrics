import type {
  ConnectorLogFields,
  ConnectorLogger,
  ConnectorLogLevel,
  ConnectorLogValue,
} from "@netrics/connector-sdk";

import { redactCredentialValues } from "./redact.js";

/**
 * One sanitized connector log line as the host receives it. The host adds
 * the attribution (connection, run, attempt) when it writes the line.
 */
export interface ConnectorLogEntry {
  level: ConnectorLogLevel;
  /** The manifest id of the connector that logged the line. */
  connector: string;
  message: string;
  fields: Record<string, ConnectorLogValue>;
}

/** Where the host writes connector log lines (ExecuteOptions.log). */
export type ConnectorLogSink = (entry: ConnectorLogEntry) => void;

/** Longest message or string field kept; longer ones are cut. */
export const CONNECTOR_LOG_MAX_STRING = 500;
/** Fields kept per line; further ones are dropped. */
export const CONNECTOR_LOG_MAX_FIELDS = 20;
/** Lines kept per connector call; further ones are dropped. */
export const CONNECTOR_LOG_MAX_LINES = 200;

const REDACTED = "[redacted]";
/**
 * Field names whose value is never logged. Broader than redactSecrets'
 * pattern: connector fields are free-form, so header-like names count too.
 */
const SECRET_FIELD_PATTERN =
  /secret|token|password|passwd|credential|key|auth|cookie|session|signature|bearer|jwt/i;
/** Field names: short identifiers, nothing a value could hide in. */
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/**
 * Values that look like a credential whatever their field is called: a
 * bearer/basic authorization value, a JWT, or a PEM block.
 */
const SECRET_VALUE_PATTERNS = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
  /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g,
];

function cut(text: string): string {
  return text.length > CONNECTOR_LOG_MAX_STRING
    ? `${text.slice(0, CONNECTOR_LOG_MAX_STRING)}…`
    : text;
}

/**
 * Builds the ConnectorLogger handed to connector code for one call. Every
 * line is sanitized before it reaches the sink: credential values and
 * secret-looking strings are replaced with "[redacted]", fields with a
 * secret-like name are redacted, non-scalar fields and malformed names are
 * dropped, strings are truncated, and lines past the per-call limit or
 * after the call ended (`active()` false) are dropped. It never throws.
 */
export function createConnectorLogger(input: {
  connectorId: string;
  credentials: Record<string, unknown>;
  sink: ConnectorLogSink | undefined;
  /** False once the call has ended; later lines are dropped. */
  active: () => boolean;
}): ConnectorLogger {
  const { connectorId, credentials, sink, active } = input;
  let lines = 0;
  let limitNoted = false;

  const clean = (text: string): string => {
    let result = redactCredentialValues(text, credentials);
    for (const pattern of SECRET_VALUE_PATTERNS) {
      result = result.replace(pattern, REDACTED);
    }
    return cut(result);
  };

  const cleanFields = (fields: unknown): Record<string, ConnectorLogValue> => {
    const result: Record<string, ConnectorLogValue> = {};
    if (fields === null || typeof fields !== "object" || Array.isArray(fields))
      return result;
    let count = 0;
    for (const [name, value] of Object.entries(fields)) {
      if (count >= CONNECTOR_LOG_MAX_FIELDS) break;
      if (!FIELD_NAME_PATTERN.test(name)) continue;
      if (SECRET_FIELD_PATTERN.test(name)) {
        result[name] = REDACTED;
      } else if (typeof value === "string") {
        result[name] = clean(value);
      } else if (typeof value === "number") {
        result[name] = Number.isFinite(value) ? value : String(value);
      } else if (typeof value === "boolean" || value === null) {
        result[name] = value;
      } else {
        // Objects, arrays, functions and the like may carry raw records
        // or credentials: refused, not serialized.
        continue;
      }
      count += 1;
    }
    return result;
  };

  const write =
    (level: ConnectorLogLevel) =>
    (message: unknown, fields?: ConnectorLogFields): void => {
      if (!sink || !active()) return;
      try {
        if (lines >= CONNECTOR_LOG_MAX_LINES) {
          if (!limitNoted) {
            limitNoted = true;
            sink({
              level: "warn",
              connector: connectorId,
              message: `connector log limit of ${CONNECTOR_LOG_MAX_LINES} lines per call reached; further lines dropped`,
              fields: {},
            });
          }
          return;
        }
        lines += 1;
        sink({
          level,
          connector: connectorId,
          message: clean(
            typeof message === "string" ? message : "(no message)",
          ),
          fields: cleanFields(fields),
        });
      } catch {
        // Logging never fails a connector call.
      }
    };

  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
}
