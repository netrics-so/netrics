import type { Locale } from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password-reset";

/** The parts of a better-auth client error the pages read. */
export interface AuthErrorLike {
  status?: number;
  code?: string;
  message?: string;
}

/** What the failed request was for: picks the message for unknown codes. */
export type AuthAction = "signIn" | "signUp" | "setup" | "changePassword";

const FALLBACKS = {
  signIn: "signInFailed",
  signUp: "signUpFailed",
  setup: "setupFailed",
  changePassword: "changePasswordFailed",
} as const;

/**
 * A better-auth error in the user's language (ADR 0016): known codes from
 * the catalog, anything else a plain failure message. better-auth's own
 * English `message` is never shown, and nothing echoes input back.
 */
export function authErrorMessage(
  error: AuthErrorLike,
  locale: Locale,
  action?: AuthAction,
): string {
  const t = webTranslator(locale, "authErrors");
  if (error.status === 429) {
    return t("tooManyAttempts");
  }
  switch (error.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return t("invalidCredentials");
    case "INVALID_PASSWORD":
      return action === "changePassword"
        ? t("wrongPassword")
        : t("invalidCredentials");
    case "INVALID_EMAIL":
      return t("invalidEmail");
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return t("userExists");
    case "PASSWORD_TOO_SHORT":
      return t("passwordTooShort", { count: PASSWORD_MIN_LENGTH });
    case "PASSWORD_TOO_LONG":
      return t("passwordTooLong", { count: PASSWORD_MAX_LENGTH });
    case "SIGNUP_DISABLED":
      return t("signupDisabled");
    case "EMAIL_NOT_VERIFIED":
      return t("emailNotVerified");
    case "SESSION_EXPIRED":
    case "SESSION_NOT_FRESH":
      return t("sessionExpired");
    case "INVALID_TOKEN":
    case "TOKEN_EXPIRED":
      return t("invalidToken");
  }
  return t(action ? FALLBACKS[action] : "generic");
}
