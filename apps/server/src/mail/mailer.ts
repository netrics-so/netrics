import type { FastifyBaseLogger } from "fastify";
import nodemailer, { type Transporter } from "nodemailer";

import type { Locale } from "@netrics/domain";

import type { Config } from "../env.js";
import {
  renderInvitationEmail,
  renderPasswordResetEmail,
  renderVerificationEmail,
  type RenderedEmail,
} from "./render.js";

/**
 * Every email netrics sends contains a bearer link: whoever holds it can
 * verify the address, reset the password or accept an invitation. So
 * implementations never write the link to logs outside local development.
 */
export interface LinkEmail {
  to: string;
  url: string;
  /** The recipient's language (see ./locale.ts for the rules). */
  locale: Locale;
}

export interface InvitationEmail extends LinkEmail {
  workspaceName: string;
  /** Null when unknown: the email then names "a workspace admin". */
  inviterName: string | null;
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
    async ({ to, url, locale }: LinkEmail) => {
      logger.info({ to, url, locale }, `email: ${kind} (dev log mailer)`);
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

  const send = async (kind: string, to: string, email: RenderedEmail) => {
    try {
      await transporter.sendMail({
        from: options.from,
        to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });
    } catch (error) {
      // Log the failure without the message body (it contains the link).
      options.logger.error(
        { to, err: error instanceof Error ? error.message : String(error) },
        `email delivery failed (${kind})`,
      );
      throw error;
    }
  };

  return {
    delivers: true,
    sendVerificationEmail: (email) =>
      send("verification", email.to, renderVerificationEmail(email)),
    sendPasswordResetEmail: (email) =>
      send("password reset", email.to, renderPasswordResetEmail(email)),
    sendInvitationEmail: (email) =>
      send("invitation", email.to, renderInvitationEmail(email)),
  };
}
