import { describe, expect, it, vi } from "vitest";

import type { Locale } from "@netrics/domain";

import { CreateWorkspaceForm } from "../(onboarding)/create-workspace-form";
import { ForgotPasswordForm } from "./forgot-password/forgot-password-form";
import { InvitationActions } from "./invite/[token]/invitation-actions";
import { LoginForm } from "./login/login-form";
import { ResetPasswordForm } from "./reset-password/reset-password-form";
import { SetupForm } from "./setup/setup-form";
import { SignupForm } from "./signup/signup-form";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

function forms(locale: Locale) {
  return renderI18n(
    <>
      <CreateWorkspaceForm />
      <LoginForm next="/" />
      <SignupForm />
      <SetupForm initialToken="" />
      <ForgotPasswordForm />
      <ResetPasswordForm token="t" />
    </>,
    locale,
  );
}

function invitation(locale: Locale, signedInEmail: string | null) {
  return renderI18n(
    <InvitationActions
      token="t"
      invitedEmail="ada@example.com"
      signedInEmail={signedInEmail}
    />,
    locale,
  );
}

describe("auth and onboarding forms", () => {
  it("render in English", () => {
    const html = forms("en");
    for (const text of [
      "Workspace name",
      "Add demo data and a sample dashboard",
      "Create workspace",
      "Sign in",
      "Create account",
      "Setup token",
      "Create owner account",
      "Send reset link",
      "Confirm new password",
      "At least 8 characters.",
      "Password",
    ]) {
      expect(html).toContain(text);
    }
  });

  it("render in German", () => {
    const html = forms("de");
    for (const text of [
      "Name des Workspaces",
      "Demodaten und ein Beispiel-Dashboard hinzufügen",
      "Workspace erstellen",
      "Anmelden",
      "Konto erstellen",
      "Einrichtungs-Token",
      "Inhaber-Konto erstellen",
      "Link senden",
      "Neues Passwort bestätigen",
      "Mindestens 8 Zeichen.",
      "Passwort",
      "E-Mail",
    ]) {
      expect(html).toContain(text);
    }
    for (const english of ["Sign in", "Create account", "Email", "Password<"]) {
      expect(html).not.toContain(english);
    }
  });

  it("word the invitation in both languages", () => {
    expect(invitation("en", null)).toContain("Create account and join");
    expect(invitation("de", null)).toContain("Konto erstellen und beitreten");
    expect(invitation("de", "ada@example.com")).toContain("Einladung annehmen");
    expect(invitation("de", "bob@example.com")).toContain(
      "Du bist als bob@example.com angemeldet, aber diese Einladung gilt für ada@example.com.",
    );
    expect(invitation("en", "bob@example.com")).toContain(
      "You are signed in as bob@example.com, but this invitation is for ada@example.com.",
    );
  });
});
