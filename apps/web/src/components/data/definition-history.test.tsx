import { describe, expect, it } from "vitest";
import { renderI18n } from "@/lib/i18n/test-render";
import { DefinitionHistory } from "./definition-history";

describe("published definition history controls", () => {
  it.each(["en", "de"] as const)(
    "explains pinned inputs and exposes an explicit adoption action in %s",
    (locale) => {
      const html = renderI18n(
        <DefinitionHistory
          workspaceId="workspace"
          kind="models"
          id="model"
          publishedVersion={4}
          restoredFromVersion={1}
          disabled={false}
          unsaved={false}
          onRestore={async () => {}}
          onAdoptLatest={async () => {}}
        />,
        locale,
      );
      expect(html).toContain('aria-expanded="false"');
      expect(html).toContain(
        locale === "en"
          ? "Published version history"
          : "Veröffentlichte Versionen",
      );
      expect(html).toContain(
        locale === "en"
          ? "source-data corrections still apply"
          : "Korrekturen der Quelldaten gelten weiterhin",
      );
      expect(html).toContain(
        locale === "en"
          ? "Use latest published inputs"
          : "Neueste veröffentlichte Eingaben verwenden",
      );
      expect(html).not.toContain("undefined");
    },
  );
  it("protects unsaved edits from replacing their input versions", () => {
    const html = renderI18n(
      <DefinitionHistory
        workspaceId="workspace"
        kind="preparations"
        id="preparation"
        publishedVersion={2}
        restoredFromVersion={1}
        disabled={false}
        unsaved={true}
        onRestore={async () => {}}
        onAdoptLatest={async () => {}}
      />,
    );
    expect(html).toContain(
      '<button type="button" disabled="">Use latest published inputs</button>',
    );
  });
});
