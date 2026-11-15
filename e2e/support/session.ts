import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type { DataField } from "@netrics/domain";
import type { Locale } from "./labels.ts";
import { ORIGIN } from "./origin.ts";

const acceptLanguage = (locale: Locale) =>
  locale === "de" ? "de-DE,de;q=0.9" : "en-US,en;q=0.9";

/**
 * A new account and workspace for one test, signed in on `page`. The
 * account's language comes from Accept-Language at sign-up, as for a
 * customer signing up in that browser language.
 */
export async function startWorkspace(
  page: Page,
  locale: Locale,
): Promise<{ workspaceId: string }> {
  const id = randomUUID();
  const headers = { origin: ORIGIN, "accept-language": acceptLanguage(locale) };
  const signUp = await page.request.post("/api/auth/sign-up/email", {
    headers,
    data: {
      name: "Journey " + locale,
      email: `e2e-${id}@example.com`,
      password: "e2e-password-" + id,
    },
  });
  expect(signUp.status(), await signUp.text()).toBe(200);
  const created = await page.request.post("/v1/workspaces", {
    headers,
    data: { name: "Journey " + locale },
  });
  expect(created.status(), await created.text()).toBe(200);
  const body = (await created.json()) as { workspace: { id: string } };
  return { workspaceId: body.workspace.id };
}

/**
 * A reference table holding `rows`, stored as one complete page through the
 * endpoint the reference editor uses (manualDatasetPageInputSchema).
 * Answers the dataset ID.
 */
export async function seedReferenceTable(
  page: Page,
  workspaceId: string,
  table: {
    name: string;
    key: string;
    fields: DataField[];
    rows: Record<string, unknown>[];
    /** Defaults to the first field. */
    keyFields?: string[];
  },
): Promise<string> {
  const response = await page.request.post(
    `/v1/workspaces/${workspaceId}/data/manual/pages`,
    {
      headers: { origin: ORIGIN },
      data: {
        generationId: null,
        definition: {
          key: table.key,
          name: table.name,
          version: 1,
          mode: "snapshot",
          keyFields: table.keyFields ?? [table.fields[0]!.id],
          grain: "one reference record",
          retentionDays: null,
          fields: table.fields.map((field) => ({
            ...field,
            classification: "internal",
          })),
        },
        refreshId: randomUUID(),
        page: 0,
        complete: true,
        records: table.rows.map((values) => ({ values })),
      },
    },
  );
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { datasetId: string }).datasetId;
}
