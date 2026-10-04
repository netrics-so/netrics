import {
  localeFromAcceptLanguage,
  resolveLocale,
  type Locale,
} from "@netrics/domain";

/**
 * The language of an email to a user (verification, password reset):
 * the recipient's setting → the instance default → English
 * (ADR 0016 section 3).
 */
export function recipientEmailLocale(input: {
  recipientLocale: string | null | undefined;
  defaultLocale: string | null | undefined;
}): Locale {
  return resolveLocale([input.recipientLocale, input.defaultLocale]);
}

/**
 * The language of an invitation: the recipient's setting when the address
 * already has an account, else the language the inviter uses netrics in
 * (their setting → the instance default → their browser's language, the
 * same chain the web app applies to them), else English (ADR 0016
 * section 3). Invitations are sent from the inviter's request, so the
 * inviter's browser language is known; the recipient's is not.
 */
export function invitationEmailLocale(input: {
  recipientLocale: string | null | undefined;
  inviterLocale: string | null | undefined;
  defaultLocale: string | null | undefined;
  inviterAcceptLanguage: string | null | undefined;
}): Locale {
  return resolveLocale([
    input.recipientLocale,
    input.inviterLocale,
    input.defaultLocale,
    localeFromAcceptLanguage(input.inviterAcceptLanguage),
  ]);
}
