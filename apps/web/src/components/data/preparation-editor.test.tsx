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
  it.each([
    ["en", 3, 3, "Published v3</p>"],
    ["en", 4, 3, "Published v3 · Unpublished changes</p>"],
    ["de", 4, 3, " · Unveröffentlichte Änderungen</p>"],
    ["en", 2, null, "Not published</p>"],
  ] as const)(
    "marks a saved draft ahead of its release as unpublished (%s, v%i of v%s) (#632)",
    (locale, version, publishedVersion, meta) => {
      const html = renderI18n(
        <PreparationEditor
          workspaceId="workspace"
          sources={[]}
          initial={{
            id: "00000000-0000-4000-8000-000000000001",
            name: "Sales",
            graph: { version: 1, nodes: [], outputs: [] },
            projectId: null,
            version,
            publishedVersion,
            updatedAt: "2026-11-01T00:00:00.000Z",
          }}
          onSaved={() => {}}
          onClose={() => {}}
          onDirty={() => {}}
        />,
        locale,
      );
      expect(html).toContain(meta);
    },
  );
});
