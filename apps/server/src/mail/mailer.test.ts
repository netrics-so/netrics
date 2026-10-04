import nodemailer from "nodemailer";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  EmailNotConfiguredError,
  createSmtpMailer,
  createUnavailableMailer,
} from "./mailer.js";

const SECRET_URL = "https://app.example.com/reset?token=super-secret-token";

function captureLogger() {
  const lines: string[] = [];
  const logger = pino(
    { level: "trace" },
    { write: (line: string) => lines.push(line) },
  );
  return { logger, lines };
}

describe("createSmtpMailer", () => {
  it("sends the link by email", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sendMail = vi.spyOn(transport, "sendMail");
    const { logger } = captureLogger();

    await createSmtpMailer({
      from: "netrics <no-reply@example.com>",
      transport,
      logger,
    }).sendPasswordResetEmail({
      to: "user@example.com",
      url: SECRET_URL,
      locale: "en",
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const [mail] = sendMail.mock.calls[0]!;
    expect(mail).toMatchObject({
      from: "netrics <no-reply@example.com>",
      to: "user@example.com",
      subject: "Reset your password",
    });
    expect(String(mail.text)).toContain(SECRET_URL);
    expect(String(mail.html)).toContain(`href="${SECRET_URL}"`);
  });

  it("sends each email in the recipient's language", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sendMail = vi.spyOn(transport, "sendMail");
    const { logger } = captureLogger();
    const mailer = createSmtpMailer({
      from: "x@example.com",
      transport,
      logger,
    });

    await mailer.sendVerificationEmail({
      to: "a@example.com",
      url: SECRET_URL,
      locale: "de",
    });
    await mailer.sendInvitationEmail({
      to: "b@example.com",
      url: SECRET_URL,
      locale: "de",
      workspaceName: "Acme",
      inviterName: "Ada",
    });

    expect(sendMail.mock.calls.map(([mail]) => mail.subject)).toEqual([
      "Bestätige deine E-Mail-Adresse",
      "Ada hat dich zu Acme auf netrics eingeladen",
    ]);
  });

  it("logs a failed delivery without the link", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    vi.spyOn(transport, "sendMail").mockRejectedValue(new Error("refused"));
    const { logger, lines } = captureLogger();

    await expect(
      createSmtpMailer({
        from: "x@example.com",
        transport,
        logger,
      }).sendPasswordResetEmail({
        to: "user@example.com",
        url: SECRET_URL,
        locale: "de",
      }),
    ).rejects.toThrow("refused");

    expect(lines.join("\n")).toContain("email delivery failed");
    expect(lines.join("\n")).not.toContain("super-secret-token");
  });
});

describe("createUnavailableMailer", () => {
  it("refuses to send and never logs the secret link", async () => {
    const { logger, lines } = captureLogger();
    const mailer = createUnavailableMailer(logger);

    await expect(
      mailer.sendPasswordResetEmail({
        to: "user@example.com",
        url: SECRET_URL,
        locale: "en",
      }),
    ).rejects.toThrow(EmailNotConfiguredError);
    await expect(
      mailer.sendVerificationEmail({
        to: "user@example.com",
        url: SECRET_URL,
        locale: "de",
      }),
    ).rejects.toThrow(EmailNotConfiguredError);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("super-secret-token");
  });
});
