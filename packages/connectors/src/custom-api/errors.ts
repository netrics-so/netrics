// Error classes of the custom-api connector. Their names survive the
// runtime's redaction (it keeps `error.name`), so the host classifies them
// by name; messages are fixed sentences that never carry a value.

import type { CUSTOM_API_MESSAGES } from "./messages.js";

type Messages = typeof CUSTOM_API_MESSAGES;

export const CUSTOM_API_LIMIT_ERROR = "CustomApiLimitError";
export const CUSTOM_API_AUTH_ERROR = "CustomApiAuthError";

/** A run safety limit (pages, records, duration) was reached. */
export class CustomApiLimitError extends Error {
  constructor(
    message: Messages["pageLimit" | "recordLimit" | "durationLimit"],
  ) {
    super(message);
    this.name = CUSTOM_API_LIMIT_ERROR;
  }
}

/** The API refused the credentials, or they belong to another host. */
export class CustomApiAuthError extends Error {
  constructor(message: Messages["unauthorized" | "forbidden" | "hostChanged"]) {
    super(message);
    this.name = CUSTOM_API_AUTH_ERROR;
  }
}

/** The response cannot be read as the definition describes. */
export class CustomApiResponseError extends Error {
  constructor(message: Messages[keyof Messages]) {
    super(message);
    this.name = "CustomApiResponseError";
  }
}

/** The connection's pin or values do not fit its definition. */
export class CustomApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomApiConfigError";
  }
}
