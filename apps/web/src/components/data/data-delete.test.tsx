import { afterEach, describe, expect, it, vi } from "vitest";
import { renderI18n } from "@/lib/i18n/test-render";
import { ApiError } from "@/lib/api";
import { deleteDataItem } from "@/lib/data-api";
import {
  DataInUseNotice,
  DataWorkspace,
  deleteFailure,
} from "./data-workspace";

// Deleting preparations and models (#671).

const PREP = "00000000-0000-4000-8000-0000000000a1";
const MODEL = "00000000-0000-4000-8000-0000000000b1";
const BOARD = "00000000-0000-4000-8000-0000000000c1";
const REQUEST = "00000000-0000-4000-8000-0000000000d1";

const preparation = {
  id: PREP,
  name: "Orders cleaned",
  graph: { version: 1 as const, nodes: [], outputs: [] },
  projectId: null,
  version: 1,
  publishedVersion: 1,
  hasUnpublishedChanges: false,
  updatedAt: "2026-11-16T00:00:00.000Z",
};
const model = {
  id: MODEL,
  name: "Revenue",
  definition: {
    version: 1 as const,
    datasets: [],
    relationships: [],
    dimensions: [],
    measures: [],
  },
  projectId: null,
  version: 1,
  publishedVersion: 1,
  hasUnpublishedChanges: false,
  updatedAt: "2026-11-16T00:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("the delete action", () => {
  it("is offered per preparation and model to those who may delete", () => {
    const initial = { sources: [], preparations: [preparation], models: [] };
    const allowed = renderI18n(
      <DataWorkspace
        workspaceId="workspace"
        initial={initial}
        initialSection="preparations"
        canDelete
      />,
    );
    expect(allowed).toContain('aria-label="Delete Orders cleaned"');
    const editor = renderI18n(
      <DataWorkspace
        workspaceId="workspace"
        initial={initial}
        initialSection="preparations"
      />,
    );
    expect(editor).not.toContain("Delete Orders cleaned");
  });

  it("is offered in an open model's editor, also of another project", () => {
    const html = renderI18n(
      <DataWorkspace
        workspaceId="workspace"
        initial={{ sources: [], preparations: [], models: [] }}
        openModelId={MODEL}
        openModel={model}
        canDelete
      />,
      "de",
    );
    expect(html).toContain('aria-label="Revenue löschen"');
  });
});

describe("what still uses an item", () => {
  const usedBy = {
    preparations: [{ id: PREP, name: "Orders cleaned" }],
    models: [{ id: MODEL, name: "Revenue" }],
    dashboards: [{ id: BOARD, name: "Sales" }],
    storeTemplates: [{ requestId: REQUEST, name: "My apps" }],
    hidden: { preparations: 0, models: 0, dashboards: 2 },
  };

  it("names every user, links dashboards and counts the hidden (en)", () => {
    const html = renderI18n(
      <DataInUseNotice workspaceId="w1" name="Base" usedBy={usedBy} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("“Base” is still used, so it can’t be deleted.");
    expect(html).toContain("Preparation “Orders cleaned”");
    expect(html).toContain("Model “Revenue”");
    expect(html).toContain(`href="/workspaces/w1/dashboards/${BOARD}"`);
    expect(html).toContain("Dashboard “Sales”");
    expect(html).toContain("Template “My apps”");
    expect(html).toContain("2 more you can&#x27;t open");
  });

  it("names them in German", () => {
    const html = renderI18n(
      <DataInUseNotice workspaceId="w1" name="Basis" usedBy={usedBy} />,
      "de",
    );
    expect(html).toContain("„Basis“ wird noch verwendet");
    expect(html).toContain("Aufbereitung „Orders cleaned“");
    expect(html).toContain("Modell „Revenue“");
    expect(html).toContain("Vorlage „My apps“");
  });
});

describe("deleteDataItem", () => {
  it("sends DELETE and resolves on 204", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await deleteDataItem("w1", "models", MODEL);
    expect(fetch).toHaveBeenCalledWith(
      `/v1/workspaces/w1/data/models/${MODEL}`,
      {
        method: "DELETE",
      },
    );
  });

  it("throws data_in_use with what uses the item", async () => {
    const usedBy = {
      preparations: [],
      models: [{ id: MODEL, name: "Revenue" }],
      dashboards: [],
      storeTemplates: [],
      hidden: { preparations: 0, models: 0, dashboards: 0 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "data_in_use", usedBy }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const failure = await deleteDataItem("w1", "preparations", PREP).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("data_in_use");
    expect((failure as ApiError).details.usedBy).toEqual(usedBy);
  });
});

describe("a refused delete", () => {
  it("reads 404 as already gone, 403 as not allowed, 409 with its users", () => {
    expect(deleteFailure(new ApiError(404, "data_model_not_found"))).toEqual({
      kind: "gone",
    });
    expect(deleteFailure(new ApiError(403, "forbidden"))).toEqual({
      kind: "forbidden",
    });
    const usedBy = {
      preparations: [],
      models: [],
      dashboards: [{ id: BOARD, name: "Sales" }],
      storeTemplates: [],
      hidden: { preparations: 0, models: 0, dashboards: 0 },
    };
    expect(deleteFailure(new ApiError(409, "data_in_use", { usedBy }))).toEqual(
      { kind: "inUse", usedBy },
    );
    expect(deleteFailure(new ApiError(409, "version_conflict"))).toEqual({
      kind: "busy",
    });
    expect(deleteFailure(new ApiError(503, "data_storage_failed"))).toEqual({
      kind: "other",
    });
    expect(deleteFailure(new TypeError("offline"))).toEqual({ kind: "other" });
  });

  it("says who may delete, in en and de", async () => {
    const { dataEn } = await import("@/messages/data/en");
    const { dataDe } = await import("@/messages/data/de");
    expect(dataEn.data.delete.forbidden).toContain("owners and admins");
    expect(dataDe.data.delete.forbidden).toContain("Inhaber und Admins");
    expect(dataEn.data.delete.busy).toContain("again in a moment");
    expect(dataDe.data.delete.busy).toContain("gleich noch einmal");
  });
});
