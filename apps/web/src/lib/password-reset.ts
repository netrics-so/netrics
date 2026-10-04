/**
 * Pure helpers for the forgot-password and reset-password pages. The limits
 * mirror the API's better-auth config (apps/server/src/auth/index.ts).
 */

import type { Locale } from "@netrics/domain";

import type { AuthErrorLike } from "./auth-errors";
import { webTranslator } from "./i18n/catalogs";

export const PASSWORD_MIN_LENGTH = 8;
/** better-auth's default maximum. */
export const PASSWORD_MAX_LENGTH = 128;
/** How long an emailed reset link works (the API's resetPasswordTokenExpiresIn). */
export const RESET_LINK_LIFETIME_HOURS = 1;

/**
 * Where the emailed link leads after the API checked its token. Absolute on
 * the page's own origin: the API resolves a relative path against
 * BETTER_AUTH_URL, which need not be the web app's address, and accepts only
 * WEB_ORIGIN here.
 */
export function resetPasswordRedirect(origin: string): string {
  return new URL("/reset-password", origin).toString();
}

export type ResetLinkState =
  { kind: "ready"; token: string } | { kind: "invalid" } | { kind: "missing" };

/**
 * The query better-auth hands the page: `?token=…` for a valid link, or
 * `?error=INVALID_TOKEN` for an unknown, used or expired one.
 */
export function readResetLink(query: {
  token?: string | string[];
  error?: string | string[];
}): ResetLinkState {
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  const error = first(query.error);
  const token = first(query.token)?.trim();
  if (error) return { kind: "invalid" };
  if (token) return { kind: "ready", token };
  return { kind: "missing" };
}

/** The message for a new password the form must not submit, or null. */
export function newPasswordProblem(
  password: string,
  confirmation: string,
  locale: Locale,
): string | null {
  const t = webTranslator(locale, "authErrors");
  if (password.length < PASSWORD_MIN_LENGTH) {
    return t("passwordTooShort", { count: PASSWORD_MIN_LENGTH });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return t("passwordTooLong", { count: PASSWORD_MAX_LENGTH });
  }
  if (password !== confirmation) {
    return webTranslator(locale, "passwordReset")("mismatch");
  }
  return null;
}

/** Whether a reset failed because the link can no longer be used. */
export function isInvalidTokenError(error: AuthErrorLike): boolean {
  return error.code === "INVALID_TOKEN" || error.code === "USER_NOT_FOUND";
}
