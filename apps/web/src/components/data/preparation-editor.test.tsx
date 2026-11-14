import { describe, expect, it } from "vitest";
import { renderI18n } from "@/lib/i18n/test-render";
import { PreparationEditor } from "./preparation-editor";

describe("PreparationEditor", () => {
  it.each([
    ["en", "Undo", "Redo"],
    ["de", "Rückgängig", "Wiederholen"],
  ] as const)(
    "offers disabled undo and redo before any edit (%s)",
    (locale, undo, redo) => {
      const html = renderI18n(
        <PreparationEditor
          workspaceId="workspace"
          sources={[]}
          initial={null}
          onSaved={() => {}}
          onClose={() => {}}
          onDirty={() => {}}
        />,
        locale,
      );
      expect(html).toContain(
        `<button type="button" disabled="">${undo}</button>`,
      );
      expect(html).toContain(
        `<button type="button" disabled="">${redo}</button>`,
      );
    },
  );
});
