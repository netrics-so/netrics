import {
  createNamespacedTranslator,
  type Catalog,
  type Locale,
  type Translator,
} from "@netrics/domain";

import {
  INVITATION_TTL_MS,
  PASSWORD_RESET_TTL_SECONDS,
} from "../link-lifetimes.js";
import { de } from "./messages/de.js";
import { en, type MailMessages } from "./messages/en.js";

const CATALOGS: Readonly<Record<Locale, Catalog<MailMessages>>> = { en, de };

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface VerificationEmailContent {
  url: string;
  locale: Locale;
}

export type PasswordResetEmailContent = VerificationEmailContent;

export interface InvitationEmailContent extends VerificationEmailContent {
  workspaceName: string;
  /** Null when the inviter is unknown; the email then names "a workspace admin". */
  inviterName: string | null;
}

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function translator<N extends keyof MailMessages & string>(
  locale: Locale,
  namespace: N,
) {
  return createNamespacedTranslator<MailMessages, N>(
    { locale, messages: CATALOGS[locale], fallback: en },
    namespace,
  );
}

/** A value shown in bold in the HTML part (plain in the text part). */
interface Strong {
  strong: string;
}

interface Paragraph {
  text: string;
  html: string;
}

/**
 * One message as plain text and as an HTML paragraph. In the HTML, the
 * catalog text and every argument are escaped, so user-controlled values
 * (workspace and inviter names) cannot inject markup; arguments named in
 * `strong` are set in bold.
 */
function paragraph<Key extends string>(
  t: Translator<Key>,
  key: Key,
  values: Readonly<Record<string, string | number>> = {},
  strong: readonly string[] = [],
): Paragraph {
  const htmlValues: Record<string, string | number | Strong> = { ...values };
  for (const name of strong) {
    const value = values[name];
    if (typeof value === "string") {
      htmlValues[name] = { strong: value };
    }
  }
  const inner = t
    .rich<Strong>(key, htmlValues)
    .map((part) =>
      typeof part === "string"
        ? escapeHtml(part)
        : `<strong>${escapeHtml(part.strong)}</strong>`,
    )
    .join("");
  return {
    text: t(key, values),
    html: `<p style="margin:0 0 16px">${inner}</p>`,
  };
}

interface Layout {
  locale: Locale;
  /** Paragraphs before the link, as text and HTML. */
  before: Paragraph[];
  action: string;
  url: string;
  /** Paragraphs after the link. */
  after: Paragraph[];
}

function layout(subject: string, parts: Layout): RenderedEmail {
  const t = translator(parts.locale, "layout");
  const url = escapeHtml(parts.url);
  const text = [
    ...parts.before.map((p) => p.text),
    parts.url,
    ...parts.after.map((p) => p.text),
  ].join("\n\n");
  const html =
    `<!doctype html><html lang="${parts.locale}"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:24px;background:#f6f6f7;color:#111;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;` +
    `font-size:15px;line-height:1.5">` +
    `<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:8px;padding:24px">` +
    parts.before.map((p) => p.html).join("") +
    `<p style="margin:0 0 16px"><a href="${url}" style="display:inline-block;` +
    `background:#111;color:#fff;text-decoration:none;padding:10px 16px;` +
    `border-radius:6px">${escapeHtml(parts.action)}</a></p>` +
    `<p style="margin:0 0 16px;font-size:13px;color:#555">` +
    `${escapeHtml(t("linkHint"))}<br><a href="${url}" style="color:#555;` +
    `word-break:break-all">${url}</a></p>` +
    parts.after.map((p) => p.html).join("") +
    `<p style="margin:16px 0 0;font-size:12px;color:#888">${escapeHtml(t("footer"))}</p>` +
    `</div></body></html>`;
  return { subject, text: `${text}\n`, html };
}

export function renderVerificationEmail({
  url,
  locale,
}: VerificationEmailContent): RenderedEmail {
  const t = translator(locale, "verification");
  return layout(t("subject"), {
    locale,
    before: [paragraph(t, "intro")],
    action: t("action"),
    url,
    after: [paragraph(t, "ignore")],
  });
}

export function renderPasswordResetEmail({
  url,
  locale,
}: PasswordResetEmailContent): RenderedEmail {
  const t = translator(locale, "passwordReset");
  const hours = Math.round(PASSWORD_RESET_TTL_SECONDS / 3600);
  return layout(t("subject"), {
    locale,
    before: [paragraph(t, "intro")],
    action: t("action"),
    url,
    after: [paragraph(t, "expiry", { hours }), paragraph(t, "ignore")],
  });
}

export function renderInvitationEmail({
  url,
  locale,
  workspaceName,
  inviterName,
}: InvitationEmailContent): RenderedEmail {
  const t = translator(locale, "invitation");
  const names = {
    inviterName: inviterName?.trim() || t("someone"),
    workspaceName,
  };
  const days = Math.round(INVITATION_TTL_MS / (24 * 60 * 60 * 1000));
  return layout(t("subject", names), {
    locale,
    before: [paragraph(t, "intro", names, ["workspaceName"])],
    action: t("action"),
    url,
    after: [paragraph(t, "expiry", { days }), paragraph(t, "ignore")],
  });
}
