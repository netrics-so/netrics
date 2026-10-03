import { inspect } from "node:util";

const REDACTED = "[redacted]";

/**
 * A configuration secret (e.g. an OAuth client secret) that does not print:
 * logging, JSON serialization, string conversion and util.inspect all show
 * "[redacted]". Only `reveal()` returns the value, at the point of use.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
