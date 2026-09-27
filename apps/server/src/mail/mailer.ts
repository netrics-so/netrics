import type { FastifyBaseLogger } from "fastify";
import nodemailer, { type Transporter } from "nodemailer";

import type { Config } from "../env.js";

/**
 * Every email netrics sends contains a bearer link: whoever holds it can
 * verify the address, reset the password or accept an invitation. So
 * implementations never write the link to logs outside local development.
 */
export interface LinkEmail {
  to: string;
  url: string;
}

export interface InvitationEmail extends LinkEmail {
  workspaceName: string;
  inviterName: string;
}

export interface Mailer {
  /**
   * True when emails actually reach the recipient. When false, callers that
   * can (invitations) hand the link to an administrator instead.
   */
  readonly delivers: boolean;
  sendVerificationEmail(email: LinkEmail): Promise<void>;
  sendPasswordResetEmail(email: LinkEmail): Promise<void>;
  sendInvitationEmail(email: InvitationEmail): Promise<void>;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Email delivery is not configured (set SMTP_URL and MAIL_FROM).");
    this.name = "EmailNotConfiguredError";
  }
}

/** SMTP when configured; the log mailer only in local development. */
export function createMailer(
  config: Config,
  logger: FastifyBaseLogger,
): Mailer {
  if (config.smtp) {
    return createSmtpMailer({
      from: config.smtp.from,
      transport: config.smtp.url,
      logger,
    });
  }
  return config.nodeEnv === "development"
    ? createLoggingMailer(logger)
    : createUnavailableMailer(logger);
}

/** Local development only: the link goes to the log so it can be clicked. */
export function createLoggingMailer(logger: FastifyBaseLogger): Mailer {
  const log =
    (kind: string) =>
    async ({ to, url }: LinkEmail) => {
      logger.info({ to, url }, `email: ${kind} (dev log mailer)`);
    };
  return {
    delivers: false,
    sendVerificationEmail: log("verification"),
    sendPasswordResetEmail: log("password reset"),
    sendInvitationEmail: log("invitation"),
  };
}

/**
 * Used when no SMTP transport is configured outside development: refuses to
 * send (and to log) the secret link, so the request fails visibly instead.
 */
export function createUnavailableMailer(logger: FastifyBaseLogger): Mailer {
  const refuse =
    (kind: string) =>
    async ({ to }: LinkEmail) => {
      logger.warn({ to }, `email not sent (${kind}): SMTP not configured`);
      throw new EmailNotConfiguredError();
    };
  return {
    delivers: false,
    sendVerificationEmail: refuse("verification"),
    sendPasswordResetEmail: refuse("password reset"),
    sendInvitationEmail: refuse("invitation"),
  };
}

export interface SmtpMailerOptions {
  from: string;
  /** SMTP URL, or a prebuilt transport (tests). */
  transport: string | Transporter;
  logger: FastifyBaseLogger;
}

export function createSmtpMailer(options: SmtpMailerOptions): Mailer {
  const transporter =
    typeof options.transport === "string"
      ? nodemailer.createTransport(options.transport)
      : options.transport;

  const send = async (to: string, subject: string, text: string) => {
    try {
      await transporter.sendMail({ from: options.from, to, subject, text });
    } catch (error) {
      // Log the failure without the message body (it contains the link).
      options.logger.error(
        { to, err: error instanceof Error ? error.message : String(error) },
        `email delivery failed: ${subject}`,
      );
      throw error;
    }
  };

  return {
    delivers: true,
    sendVerificationEmail: ({ to, url }) =>
      send(
        to,
        "Verify your email address",
        `Confirm your email address for netrics:\n\n${url}\n\n` +
          "If you did not create an account, you can ignore this email.",
      ),
    sendPasswordResetEmail: ({ to, url }) =>
      send(
        to,
        "Reset your password",
        `Reset your netrics password:\n\n${url}\n\n` +
          "If you did not request a reset, you can ignore this email.",
      ),
    sendInvitationEmail: ({ to, url, workspaceName, inviterName }) =>
      send(
        to,
        `${inviterName} invited you to ${workspaceName} on netrics`,
        `${inviterName} invited you to join the workspace "${workspaceName}" ` +
          `on netrics.\n\nAccept the invitation:\n\n${url}\n\n` +
          "The link expires in 7 days. If you did not expect this " +
          "invitation, you can ignore this email.",
      ),
  };
}
