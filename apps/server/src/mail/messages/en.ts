/**
 * Email subjects and bodies in English: the source catalog (ADR 0016
 * section 5). German is typed against it. ICU MessageFormat subset (see
 * @netrics/domain i18n). Every paragraph is one message; the mail renderer
 * escapes them for the HTML part, and links are added by the renderer,
 * never inside a message.
 */
export const en = {
  layout: {
    linkHint: "If the button does not work, open this link in your browser:",
    footer: "Sent by netrics.",
  },
  verification: {
    subject: "Verify your email address",
    intro: "Confirm your email address for netrics:",
    action: "Verify email address",
    ignore: "If you did not create an account, you can ignore this email.",
  },
  passwordReset: {
    subject: "Reset your password",
    intro: "Reset your netrics password:",
    action: "Reset password",
    expiry:
      "The link expires in {hours, plural, one {# hour} other {# hours}} and works once.",
    ignore:
      "If you did not request a reset, you can ignore this email; your password stays the same.",
  },
  invitation: {
    subject: "{inviterName} invited you to {workspaceName} on netrics",
    intro:
      "{inviterName} invited you to join the workspace “{workspaceName}” on netrics.",
    action: "Accept the invitation",
    expiry: "The link expires in {days, plural, one {# day} other {# days}}.",
    ignore: "If you did not expect this invitation, you can ignore this email.",
    someone: "A workspace admin",
  },
} as const;

export type MailMessages = typeof en;
