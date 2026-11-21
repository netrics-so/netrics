import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CustomApiDefinitionResponse,
  CustomApiVersionHistory,
} from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { ExportDefinitionButton } from "./export-definition";
import { restoreFlow, VersionHistory } from "./version-history";
import { D, W } from "./test-fixtures";
import { exportDefinition } from "@/lib/custom-api";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// Version history, restore and export of a custom API (#808).

const LOCALES: Locale[] = ["en", "de"];
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const HISTORY: CustomApiVersionHistory = {
  versions: [
    {
      id: id(3),
      version: 3,
      createdAt: "2026-11-20T10:00:00.000Z",
      author: { id: id(9), name: "Ada" },
      current: true,
      sameAs: 1,
      summary: { streams: 1, fields: 4, environments: 1 },
    },
    {
      id: id(2),
      version: 2,
      createdAt: "2026-11-19T09:00:00.000Z",
      author: null,
      current: false,
      sameAs: null,
      summary: { streams: 1, fields: 5, environments: 1 },
    },
  ],
  nextBefore: null,
};

const render = (locale: Locale, canRestore = true) =>
  renderI18n(
    <VersionHistory
      workspaceId={W}
      definitionId={D}
      currentVersion={3}
      canRestore={canRestore}
      initial={HISTORY}
    />,
    locale,
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VersionHistory", () => {
  it.each(LOCALES)(
    "lists versions with author and time and restores after confirming (%s)",
    async (locale) => {
      const html = render(locale);
      expect(html).toContain("Version 3 · Ada · ");
      expect(html).toContain(
        new Date("2026-11-20T10:00:00.000Z").toLocaleString(locale, {
          timeZone: "UTC",
        }),
      );
      expect(html).toContain(
        locale === "en" ? "Someone who left" : "Jemand, der nicht mehr da ist",
      );
      // Only older versions can be restored.
      const restore =
        locale === "en"
          ? "Restore this version"
          : "Diese Version wiederherstellen";
      expect(html.split(restore)).toHaveLength(2);
      expect(render(locale, false)).not.toContain(restore);

      const restoreVersion = vi.fn(
        async () =>
          ({
            definition: { currentVersion: 4 },
          }) as CustomApiDefinitionResponse,
      );
      const question = {
        title: "t",
        text: "q",
        confirm: "c",
        cancel: "x",
      };
      const ask = vi.fn(async () => true);
      await expect(
        restoreFlow({ restoreVersion }, ask, {
          workspaceId: W,
          definitionId: D,
          version: 2,
          baseVersion: 3,
          question,
        }),
      ).resolves.toEqual({ restored: true, currentVersion: 4 });
      expect(ask).toHaveBeenCalledWith(question);
      expect(restoreVersion).toHaveBeenCalledWith(W, D, 2, 3);
      // Declined: nothing is restored.
      restoreVersion.mockClear();
      await expect(
        restoreFlow({ restoreVersion }, async () => false, {
          workspaceId: W,
          definitionId: D,
          version: 2,
          baseVersion: 3,
          question,
        }),
      ).resolves.toEqual({ restored: false });
      expect(restoreVersion).not.toHaveBeenCalled();
    },
  );

  it.each(LOCALES)(
    "marks a restored version as same as the older one (%s)",
    (locale) => {
      expect(render(locale)).toContain(
        locale === "en" ? "Same as version 1" : "Gleich wie Version 1",
      );
    },
  );
});

describe("export", () => {
  it("downloads the export", async () => {
    const file = {
      format: "netrics.custom-api-definition",
      schemaVersion: 1,
      exportedAt: "2026-11-21T00:00:00.000Z",
      definition: { name: "Shop API" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(file), {
            headers: {
              "content-type": "application/json",
              "content-disposition":
                'attachment; filename="shop-api.netrics-api.json"',
            },
          }),
      ),
    );
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:export";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const link = {
      href: "",
      download: "",
      click: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal("document", {
      createElement: () => link,
      body: { append: () => {} },
    });
    await exportDefinition(W, D);
    expect(blobs).toHaveLength(1);
    const text = await blobs[0]!.text();
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 1 });
    expect(link).toMatchObject({
      href: "blob:export",
      download: "shop-api.netrics-api.json",
    });
    expect(link.click).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      `/v1/workspaces/${W}/custom-api/definitions/${D}/export`,
    );
  });

  it.each(LOCALES)("offers Export with its help (%s)", (locale) => {
    const html = renderI18n(
      <ExportDefinitionButton workspaceId={W} definitionId={D} />,
      locale,
    );
    expect(html).toContain(locale === "en" ? ">Export<" : ">Exportieren<");
    expect(html).toContain(
      locale === "en"
        ? "no logins and no connection values"
        : "keine Anmeldungen und keine Verbindungswerte",
    );
  });
});
