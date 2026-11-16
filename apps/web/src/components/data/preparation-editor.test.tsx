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
  it("serves its steps disabled until the first check returns (#729)", () => {
    // A click on the server markup before hydration, or while the first
    // check starts, would be lost: the steps take one only once it is done.
    const html = renderI18n(
      <PreparationEditor
        workspaceId="workspace"
        sources={[]}
        initial={{
          id: "00000000-0000-4000-8000-000000000001",
          name: "Sales",
          graph: {
            version: 1,
            nodes: [
              { id: "source", type: "source", datasetId: "sales" },
              {
                id: "unique",
                type: "deduplicate",
                input: "source",
                keys: ["day"],
                keep: "first",
              },
            ],
            outputs: ["unique"],
          },
          projectId: null,
          version: 1,
          publishedVersion: null,
          hasUnpublishedChanges: false,
          updatedAt: "2026-11-01T00:00:00.000Z",
        }}
        onSaved={() => {}}
        onClose={() => {}}
        onDirty={() => {}}
      />,
      "en",
    );
    const steps = html.slice(
      html.indexOf('<ol class="data-step-list">'),
      html.indexOf("</ol>"),
    );
    expect(steps.match(/<button /g)).toHaveLength(2);
    expect(steps.match(/<button [^>]*disabled=""/g)).toHaveLength(2);
    expect(html).toContain("Preparing preview…");
  });
  it.each([
    ["en", 3, 3, false, "Published v3</p>"],
    ["en", 4, 3, true, "Published v3 · Unpublished changes</p>"],
    ["de", 4, 3, true, " · Unveröffentlichte Änderungen</p>"],
    // Saved, but equal to the release by content (#697).
    ["en", 4, 3, false, "Published v3</p>"],
    ["en", 2, null, false, "Not published</p>"],
  ] as const)(
    "marks a saved draft that differs from its release as unpublished (%s, v%i of v%s, %s) (#632, #697)",
    (locale, version, publishedVersion, hasUnpublishedChanges, meta) => {
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
            hasUnpublishedChanges,
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
