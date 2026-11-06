import { stdSerializers } from "pino";

// Log serializers for every process (API, worker, scheduler). drizzle-orm
// wraps a failed query in an error whose message ends in "params: …" and
// which carries the bound values in `params`; postgres.js errors carry
// `parameters`. Those values are user content (an uploaded image's bytes,
// its name, anything else a query writes) and never belong in a log line
// (#217). The SQL text and the SQLSTATE stay, so failures remain readable.

const VALUE_KEYS = new Set(["params", "parameters"]);
const MESSAGE_PARAMS = /\nparams:[\s\S]*$/;
const STACK_PARAMS = /\nparams:[\s\S]*?(?=\n {4}at |$)/;
const MAX_DEPTH = 8;

function scrub(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object" || depth > MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, depth + 1));
  }
  const clean: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (VALUE_KEYS.has(key)) {
      continue;
    }
    if (key === "message" && typeof field === "string") {
      clean[key] = field.replace(MESSAGE_PARAMS, "");
    } else if (key === "stack" && typeof field === "string") {
      clean[key] = field.replace(STACK_PARAMS, "");
    } else {
      clean[key] = scrub(field, depth + 1);
    }
  }
  return clean;
}

export interface SerializedError {
  type: string;
  message: string;
  stack: string;
  [key: string]: unknown;
}

/** pino's error serializer without bound query values. */
export function errorSerializer(error: Error): SerializedError {
  return scrub(stdSerializers.err(error), 0) as SerializedError;
}

export const logSerializers = { err: errorSerializer };
