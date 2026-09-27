import type { FastifyBaseLogger } from "fastify";
import nodemailer, { type Transporter } from "nodemailer";

export interface AuthEmail {
  to: string;
  url: string;
}

/**
 * Outbound channel for auth emails (verification, password reset). The URL
 * is a bearer secret: whoever holds it can verify the address or reset the
 * password, so implementations must never write it to logs outside local
 * development.
 */
export interface AuthMailer {
  sendVerificationEmail(email: AuthEmail): Promise<void>;
  sendPasswordResetEmail(email: AuthEmail): Promise<void>;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Email delivery is not configured (set SMTP_URL and MAIL_FROM).");
    this.name = "EmailNotConfiguredError";
  }
}

/** Local development only: the link goes to the log so it can be clicked. */
export function createLoggingMailer(logger: FastifyBaseLogger): AuthMailer {
  return {
    async sendVerificationEmail({ to, url }) {
      logger.info({ to, url }, "auth email: verification (dev log mailer)");
    },
    async sendPasswordResetEmail({ to, url }) {
      logger.info({ to, url }, "auth email: password reset (dev log mailer)");
    },
  };
}

/**
 * Used when no SMTP transport is configured outside development: refuses to
 * send (and to log) the secret link, so the request fails visibly instead.
 */
export function createUnavailableMailer(logger: FastifyBaseLogger): AuthMailer {
  const refuse = async ({ to }: AuthEmail, kind: string) => {
    logger.warn({ to }, `auth email not sent (${kind}): SMTP not configured`);
    throw new EmailNotConfiguredError();
  };
  return {
    sendVerificationEmail: (email) => refuse(email, "verification"),
    sendPasswordResetEmail: (email) => refuse(email, "password reset"),
  };
}

export interface SmtpMailerOptions {
  from: string;
  /** SMTP URL, or a prebuilt transport (tests). */
  transport: string | Transporter;
  logger: FastifyBaseLogger;
}

export function createSmtpMailer(options: SmtpMailerOptions): AuthMailer {
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
        `auth email delivery failed: ${subject}`,
      );
      throw error;
    }
  };

  return {
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
  };
}
