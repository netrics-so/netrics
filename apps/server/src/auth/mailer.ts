import type { FastifyBaseLogger } from "fastify";

export interface AuthEmail {
  to: string;
  url: string;
}

/**
 * Outbound channel for auth emails (verification, password reset). The
 * default implementation only logs the URL — real SMTP delivery lands in
 * milestone 13. Implementations must resolve immediately after logging; the
 * caller never waits on actual delivery.
 */
export interface AuthMailer {
  sendVerificationEmail(email: AuthEmail): Promise<void>;
  sendPasswordResetEmail(email: AuthEmail): Promise<void>;
}

// Dev mailer: no SMTP exists yet (milestone 13), so the URL — which is the
// secret and the whole point in dev — goes to the structured log.
export function createLoggingMailer(logger: FastifyBaseLogger): AuthMailer {
  return {
    async sendVerificationEmail({ to, url }) {
      logger.info(
        { to, url },
        "auth email: verification (dev mailer, no SMTP)",
      );
    },
    async sendPasswordResetEmail({ to, url }) {
      logger.info(
        { to, url },
        "auth email: password reset (dev mailer, no SMTP)",
      );
    },
  };
}
