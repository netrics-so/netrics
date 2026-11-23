import { describe, expect, it, vi } from "vitest";

import type { Locale } from "@netrics/domain";

import {
  ImportDefinition,
  ImportIssues,
  importFlow,
  importSendsJsonBodies,
  readImportFile,
} from "./import-definition";
import { D, W } from "./test-fixtures";
import { CustomApiRequestError } from "@/lib/custom-api";
import { renderI18n } from "@/lib/i18n/test-render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));

// Import of an exported custom API (#808).

const LOCALES: Locale[] = ["en", "de"];

describe("import", () => {
  it("reads only JSON files of at most 512 KB", () => {
    expect(readImportFile('{"a":1}', 7)).toEqual({ ok: true, file: { a: 1 } });
    expect(readImportFile("nope", 4)).toEqual({ ok: false, error: "notJson" });
    expect(readImportFile("{}", 512 * 1024 + 1)).toEqual({
      ok: false,
      error: "tooLarge",
    });
  });

  it.each(LOCALES)("shows import issues (%s)", async (locale) => {
    const issues = [
      {
        path: "definition.variables.0.id",
        code: "variable_reserved",
        message: "A secret variable can't use a credential name",
      },
    ];
    const refused = await importFlow(
      {
        importDefinition: vi.fn(async () => {
          throw new CustomApiRequestError(
            400,
            "custom_api_import_invalid",
            issues,
          );
        }),
      },
      W,
      { file: {}, name: "", projectId: null },
    );
    expect(refused).toMatchObject({ ok: false, issues });
    const html = renderI18n(
      <ImportIssues message="unused" issues={issues} />,
      locale,
    );
    expect(html).toContain(
      locale === "en"
        ? "This file is not a valid custom API definition:"
        : "Diese Datei ist keine gültige Definition einer eigenen API:",
    );
    expect(html).toContain("<code>definition.variables.0.id</code>");
    // Without issues, the error's own message.
    expect(
      renderI18n(<ImportIssues message="Newer file" issues={[]} />, locale),
    ).toContain("Newer file");
  });

  it("asks the importer to confirm JSON bodies and sends the confirmation (ADR 0030)", async () => {
    const withJson = {
      definition: {
        streams: [
          { request: { path: "/a" } },
          {
            request: {
              method: "POST",
              body: { kind: "json", value: {}, readOnlyConfirmed: true },
            },
          },
        ],
      },
    };
    const graphqlOnly = {
      definition: {
        streams: [{ request: { method: "POST", body: { kind: "graphql" } } }],
      },
    };
    expect(importSendsJsonBodies(withJson)).toBe(true);
    expect(importSendsJsonBodies(graphqlOnly)).toBe(false);
    expect(importSendsJsonBodies(null)).toBe(false);
    const importDefinition = vi.fn(async () => ({
      definition: { id: D },
    }));
    await importFlow({ importDefinition } as never, W, {
      file: withJson,
      name: "",
      projectId: null,
      readOnlyConfirmed: true,
    });
    expect(importDefinition).toHaveBeenCalledWith(W, {
      file: withJson,
      projectId: null,
      readOnlyConfirmed: true,
    });
  });

  it("opens the new definition after an import", async () => {
    const importDefinition = vi.fn(async () => ({
      definition: { id: D },
    }));
    await expect(
      importFlow({ importDefinition } as never, W, {
        file: { format: "x" },
        name: "  Mine ",
        projectId: null,
      }),
    ).resolves.toEqual({ ok: true, definitionId: D });
    expect(importDefinition).toHaveBeenCalledWith(W, {
      file: { format: "x" },
      name: "Mine",
      projectId: null,
    });
  });

  it.each(LOCALES)("offers a file input and Import (%s)", (locale) => {
    const html = renderI18n(
      <ImportDefinition workspaceId={W} projects={[]} />,
      locale,
    );
    expect(html).toContain('type="file"');
    expect(html).toContain(
      locale === "en"
        ? "Choose a definition file"
        : "Definitionsdatei auswählen",
    );
  });
});
