import { describe, expect, it, vi } from "vitest";

import type { Invitation, Member, WorkspaceTheme } from "@netrics/contracts";
import { BUILTIN_THEMES, type Locale } from "@netrics/domain";

import { DisplayCurrencyForm } from "./display-currency-form";
import { MembersManager } from "../team/members-manager";
import { RenameWorkspaceForm } from "./rename-workspace-form";
import { ThemeEditor } from "./themes/[themeId]/theme-editor";
import { CopyBuiltinButton } from "./themes/copy-builtin-button";
import { webTranslator } from "@/lib/i18n/catalogs";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const members: Member[] = [
  {
    id: ID(1),
    userId: ID(11),
    email: "ada@example.com",
    displayName: "Ada",
    role: "owner",
    createdAt: "2026-10-01T00:00:00.000Z",
  },
  {
    id: ID(2),
    userId: ID(12),
    email: "bob@example.com",
    displayName: "Bob",
    role: "viewer",
    createdAt: "2026-10-01T00:00:00.000Z",
  },
];

const invitations: Invitation[] = [
  {
    id: ID(3),
    email: "cy@example.com",
    role: "editor",
    delivery: "email",
    invitedByName: "Ada",
    createdAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-10-08T12:00:00.000Z",
  },
];

function membersHtml(locale: Locale) {
  return renderI18n(
    <MembersManager
      workspaceId={ID(9)}
      members={members}
      actorRole="owner"
      currentUserId={ID(11)}
      canAdd
      invitations={invitations}
    />,
    locale,
  );
}

const theme: WorkspaceTheme = {
  id: ID(4),
  name: "Copy of Paper",
  base: "paper",
  tokens: BUILTIN_THEMES.paper.tokens,
  version: 1,
  warnings: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

function editorHtml(locale: Locale) {
  return renderI18n(
    <ThemeEditor
      workspaceId={ID(9)}
      theme={theme}
      baseName={locale === "de" ? "Papier" : "Paper"}
      canEdit
    />,
    locale,
  );
}

describe("members manager", () => {
  it("renders in English", () => {
    const html = membersHtml("en");
    expect(html).toContain("Members");
    expect(html).toContain("(you)");
    expect(html).toContain("Pending invitations");
    expect(html).toContain("invited as editor by Ada, expires Oct 8, 2026");
    expect(html).toContain("Invite by email");
    expect(html).toContain('aria-label="Role of Bob"');
  });

  it("renders in German with German role names and dates", () => {
    const html = membersHtml("de");
    expect(html).toContain("Mitglieder");
    expect(html).toContain("(du)");
    expect(html).toContain("Offene Einladungen");
    expect(html).toContain(
      "von Ada eingeladen als Bearbeiter, läuft am 08.10.2026 ab",
    );
    expect(html).toContain("Per E-Mail einladen");
    expect(html).toContain(">Betrachter<");
    expect(html).toContain("Zurückziehen");
    expect(html).not.toContain("Pending invitations");
  });
});

describe("theme editor", () => {
  it("renders in English", () => {
    const html = editorHtml("en");
    expect(html).toContain("Theme name");
    expect(html).toContain("Based on Paper");
    expect(html).toContain("Text on surface");
    expect(html).toContain("Normal (1.0×)");
    expect(html).toContain("Save theme");
    expect(html).toContain("Reset to Paper");
  });

  it("renders in German", () => {
    const html = editorHtml("de");
    expect(html).toContain("Name des Designs");
    expect(html).toContain("Basiert auf Papier");
    expect(html).toContain("Text auf Fläche");
    expect(html).toContain("Normal (1,0×)");
    expect(html).toContain("Kontrast");
    expect(html).toContain("Design speichern");
    expect(html).toContain("Auf Papier zurücksetzen");
    expect(html).toMatch(/\d+,\d\d:1 · /);
    expect(html).not.toContain("Save theme");
  });
});

describe("workspace forms", () => {
  it("render in both languages", () => {
    const forms = (locale: Locale) =>
      renderI18n(
        <>
          <RenameWorkspaceForm workspaceId={ID(9)} currentName="Acme" />
          <DisplayCurrencyForm
            workspaceId={ID(9)}
            currentDisplayCurrency="EUR"
            options={{
              enabled: true,
              currencies: ["EUR", "USD"],
              latestRateDate: null,
              source: {
                name: "ECB reference rate",
                url: "https://ecb.example/",
              },
            }}
          />
          <CopyBuiltinButton
            workspaceId={ID(9)}
            base="paper"
            baseName="Paper"
            takenNames={[]}
          />
        </>,
        locale,
      );
    const en = forms("en");
    expect(en).toContain("Workspace name");
    expect(en).toContain("Converted to EUR (≈)");
    expect(en).toContain("Copy and edit");
    const de = forms("de");
    expect(de).toContain("Name des Workspaces");
    expect(de).toContain("Umbenennen");
    expect(de).toContain("Pro Währung (exakt)");
    expect(de).toContain("Umgerechnet in USD (≈)");
    expect(de).toContain("ECB reference rate</a> dieses Tages");
    expect(de).toContain("Kopieren und bearbeiten");
  });
});

describe("deploy notice", () => {
  it("is worded in both languages", () => {
    expect(webTranslator("en", "deployNotice")("reloading")).toBe(
      "netrics was updated — reloading…",
    );
    expect(webTranslator("de", "deployNotice")("onNavigation")).toBe(
      "netrics wurde aktualisiert – die Seite lädt neu, sobald du weiternavigierst.",
    );
  });
});
