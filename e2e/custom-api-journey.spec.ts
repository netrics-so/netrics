import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { customApiDe } from "../apps/web/src/messages/custom-api/de.ts";
import { customApiEn } from "../apps/web/src/messages/custom-api/en.ts";
import { sourcesDe } from "../apps/web/src/messages/sources/de.ts";
import { sourcesEn } from "../apps/web/src/messages/sources/en.ts";
import { workspaceDe } from "../apps/web/src/messages/workspace/de.ts";
import { workspaceEn } from "../apps/web/src/messages/workspace/en.ts";
import { FIXTURE_SECRETS } from "../packages/connectors/src/custom-api/testing/fixture-server.ts";
import { formatMessage } from "../packages/domain/src/i18n/message-format.ts";
import { CUSTOM_API_ORIGIN } from "./support/custom-api-origin.ts";
import { ORIGIN } from "./support/origin.ts";
import type { Locale } from "./support/labels.ts";
import { startWorkspace } from "./support/session.ts";

/** The fixture server's bearer token. */
const TOKEN = FIXTURE_SECRETS.token;

const labels = (locale: Locale) =>
  ((locale === "de" ? customApiDe : customApiEn) as typeof customApiEn)
    .customApi;
const detail = (locale: Locale) =>
  ((locale === "de" ? workspaceDe : workspaceEn) as typeof workspaceEn)
    .connections.detail;
const sources = (locale: Locale) =>
  ((locale === "de" ? sourcesDe : sourcesEn) as typeof sourcesEn).sources;

/** The page never holds the token once it was sent. */
async function noToken(page: Page) {
  expect(await page.content()).not.toContain(TOKEN);
}

/**
 * The custom API builder (#807) in the browser, in English and German: a
 * member builds a custom API against the local fixture server, signs in
 * with a bearer token, tests the request, picks the records and fields,
 * tests the cursor paging, and saves it with its first connection. The
 * token never shows on a page or in an answer of the custom API routes.
 */
test("a member builds, tests and connects a custom API", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const c = labels(locale);
  const s = sources(locale);
  const answers: Promise<string>[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/custom-api/"))
      answers.push(response.text().catch(() => ""));
  });

  const { workspaceId } = await startWorkspace(page, locale);
  await page.goto(`/workspaces/${workspaceId}/sources`);
  await page.getByRole("link", { name: s.customApi.buildName }).click();
  await expect(page).toHaveURL(/\/custom-apis\/new/);

  // 1. Basics
  await page.locator("#custom-api-name").fill("Shop API");
  await page.locator("#custom-api-base-url-0").fill(CUSTOM_API_ORIGIN);
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  // 2. Login: the draft is created now and kept in the URL.
  await expect(
    page.getByRole("heading", { name: c.steps.login }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\?draft=[0-9a-f-]{36}/);
  await page.getByLabel(c.login.methods.bearer).check();
  await page.locator("#custom-api-secret-token").fill(TOKEN);
  await page.getByRole("button", { name: c.login.save }).click();
  await expect(page.getByText(c.login.secretSaved)).toBeVisible();
  await noToken(page);
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  // 3. Request
  await expect(
    page.getByRole("heading", { name: c.steps.request }),
  ).toBeVisible();
  await page.locator("#custom-api-path").fill("/builder/stats");
  const query = page.locator("fieldset", {
    has: page.locator("legend", { hasText: c.request.query }),
  });
  for (const [index, [name, value]] of [
    ["from", "{{window.start}}"],
    ["to", "{{window.end}}"],
  ].entries()) {
    await query.getByRole("button", { name: c.request.addRow }).click();
    await page
      .getByLabel(`${c.request.query} ${index + 1}: ${c.request.name}`)
      .fill(name!);
    await page
      .getByLabel(`${c.request.query} ${index + 1}: ${c.request.value}`)
      .fill(value!);
  }
  await page.getByRole("button", { name: c.request.send }).click();
  const log = page.locator(".custom-api-log-entry");
  await expect(log).toHaveCount(1);
  await expect(log.first().locator("td").nth(2)).toHaveText("200");
  await expect(page.getByText(c.test.ok)).toBeVisible();
  await noToken(page);
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  // 4. Response: the record list, then the fields.
  await expect(
    page.getByRole("heading", { name: c.steps.response }),
  ).toBeVisible();
  await page.locator('[data-pick="data"]').click();
  await expect(
    page.getByText(
      formatMessage(locale, c.response.recordsAt, { path: "data", count: 3 }),
    ),
  ).toBeVisible();
  for (const path of ["date", "orders", "revenue.amount"])
    await page.getByRole("checkbox", { name: path, exact: true }).check();
  for (const type of [
    c.response.types.date,
    c.response.types.integer,
    c.response.types.decimal,
  ])
    await expect(
      page.getByText(formatMessage(locale, c.response.suggested, { type })),
    ).toBeVisible();
  await page.getByRole("button", { name: c.response.updatePreview }).click();
  await expect(
    page.getByRole("heading", {
      name: formatMessage(locale, c.response.preview, { count: 3 }),
    }),
  ).toBeVisible();
  await expect(page.locator(".data-table tbody tr")).toHaveCount(3);
  await noToken(page);
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  // 5. Paging: a cursor picked in the response.
  await expect(
    page.getByRole("heading", { name: c.steps.paging }),
  ).toBeVisible();
  await page.getByLabel(c.paging.styles.cursor).check();
  await page.locator('[data-pick="meta.next"]').click();
  await page.getByRole("button", { name: c.paging.test }).click();
  await expect(
    page.getByText(
      formatMessage(locale, c.paging.fetched, { pages: 2, records: 6 }),
    ),
  ).toBeVisible();
  await noToken(page);
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  // 6. Schedule and review, save and connect.
  await expect(
    page.getByRole("heading", { name: c.steps.review }),
  ).toBeVisible();
  await page.locator("#custom-api-refresh").fill("60");
  await page.locator("#custom-api-backfill").fill("30");
  await expect(
    page.getByText(
      formatMessage(locale, c.review.hosts, {
        hosts: new URL(CUSTOM_API_ORIGIN).host,
      }),
      { exact: false },
    ),
  ).toBeVisible();
  await noToken(page);
  await page.getByRole("button", { name: c.review.save }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/connections/[0-9a-f-]{36}$`),
  );
  await expect(
    page.getByRole("heading", { name: "Shop API", exact: false }).first(),
  ).toBeVisible();
  // The connection shows its definition version and its data tables, not
  // observations a custom API never writes (#834).
  await expect(page.locator(".subtitle").first()).toContainText(/ v1 ·/);
  await expect(
    page.getByRole("heading", { name: detail(locale).dataTables }),
  ).toBeVisible();
  await expect(page.getByText(detail(locale).noObservations)).toHaveCount(0);
  await noToken(page);

  // Editing without the API's credentials: a schedule-only change saves a
  // new version (review #824).
  await page.goto(`/workspaces/${workspaceId}/custom-apis`);
  await page.getByRole("link", { name: c.list.edit }).click();
  await page.getByRole("button", { name: c.steps.review }).click();
  await page.locator("#custom-api-refresh").fill("30");
  await page.getByRole("button", { name: c.review.saveVersion }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/custom-apis$`),
  );
  await expect(
    page.getByText(formatMessage(locale, c.list.version, { version: 2 })),
  ).toBeVisible();

  for (const body of await Promise.all(answers))
    expect(body).not.toContain(TOKEN);
});

/** The Task 12 result as a document: daily stats by cursor, bearer login. */
function shopDocument(withCurrency: boolean) {
  return {
    schemaVersion: 1,
    name: "Shop API",
    environments: [
      { id: "production", name: "Production", baseUrl: CUSTOM_API_ORIGIN },
    ],
    variables: [],
    auth: { type: "bearer" },
    defaults: { refreshMinutes: 60, timeZone: "UTC" },
    streams: [
      {
        key: "daily_stats",
        name: "Daily stats",
        request: {
          path: "/builder/stats",
          query: { from: "{{window.start}}", to: "{{window.end}}" },
        },
        pagination: {
          type: "cursor",
          cursorPath: "meta.next",
          param: "cursor",
        },
        records: "data",
        fields: [
          {
            id: "date",
            name: "Date",
            path: "date",
            type: "date",
            nullable: false,
          },
          { id: "orders", name: "Orders", path: "orders", type: "integer" },
          {
            id: "revenue_amount",
            name: "Revenue",
            path: "revenue.amount",
            type: "decimal",
          },
          ...(withCurrency
            ? [
                {
                  id: "revenue_currency",
                  name: "Currency",
                  path: "revenue.currency",
                  type: "string",
                },
              ]
            : []),
        ],
        keyFields: ["date"],
        mode: "upsert",
        reportingField: "date",
        window: {
          type: "date",
          stepDays: 31,
          lookbackDays: 3,
          backfillDays: 30,
          paramFormat: "date",
        },
      },
    ],
  };
}

/**
 * Versions, connection updates, export and import (#808), in English and
 * German: a saved custom API gets a second version; its connection is
 * offered the update and takes it; version 1 is restored as version 3;
 * the export holds no login; the file is imported into another workspace
 * and connected there.
 */
test("a member versions, updates, exports and imports a custom API", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const c = labels(locale);
  const t = (message: string, values: Record<string, unknown> = {}) =>
    formatMessage(locale, message, values);
  const { workspaceId } = await startWorkspace(page, locale);
  const base = `/v1/workspaces/${workspaceId}/custom-api/definitions`;
  const created = await page.request.post(base, {
    headers: { origin: ORIGIN },
    data: { document: shopDocument(false) },
  });
  expect(created.status(), await created.text()).toBe(201);
  const definitionId = (
    (await created.json()) as { definition: { id: string } }
  ).definition.id;
  const connected = await page.request.post(
    `${base}/${definitionId}/connections`,
    {
      headers: { origin: ORIGIN },
      data: {
        name: "Shop API",
        environmentId: "production",
        credentials: { token: TOKEN },
      },
    },
  );
  expect(connected.status(), await connected.text()).toBe(201);
  const connectionId = (
    (await connected.json()) as { connection: { id: string } }
  ).connection.id;
  // The edit: revenue.currency is ticked, saved as version 2.
  const saved = await page.request.post(`${base}/${definitionId}/versions`, {
    headers: { origin: ORIGIN },
    data: { baseVersion: 1, document: shopDocument(true) },
  });
  expect(saved.status(), await saved.text()).toBe(201);

  // History: versions 1 and 2 with the member's name.
  const definitionPage = `/workspaces/${workspaceId}/custom-apis/${definitionId}`;
  await page.goto(definitionPage);
  const history = page.locator(".custom-api-history");
  for (const version of [1, 2])
    await expect(
      history.locator(`li[data-version="${version}"]`),
    ).toContainText(`Version ${version} · Journey ${locale} · `);
  await expect(page.locator(".custom-api-connections")).toContainText(
    c.connections.updateAvailable,
  );

  // The connection is offered the update, reviews and takes it.
  const connectionPage = `/workspaces/${workspaceId}/connections/${connectionId}`;
  await page.goto(connectionPage);
  const banner = page.locator(".custom-api-update-banner");
  await expect(banner).toContainText(
    t(c.update.banner, { name: "Shop API", version: 2 }),
  );
  await banner.getByRole("link", { name: c.update.review }).click();
  await expect(
    page.getByText(
      t(c.update.changes.field_added, {
        field: "revenue_currency",
        stream: "Daily stats",
      }),
    ),
  ).toBeVisible();
  await expect(page.getByText(c.update.login.kept)).toBeVisible();
  await page.getByRole("button", { name: c.update.apply }).click();
  // The connection's page confirms the update (#834).
  await expect(page).toHaveURL(new RegExp(`${connectionPage}\\?updated=2$`));
  await expect(page.getByText(t(c.update.done, { version: 2 }))).toBeVisible();
  await expect(page.getByRole("heading", { name: "Shop API" })).toBeVisible();
  await expect(page.locator(".custom-api-update-banner")).toHaveCount(0);

  // Restore version 1: it comes back as version 3.
  await page.goto(definitionPage);
  await history
    .locator('li[data-version="1"]')
    .getByRole("button", { name: c.history.restore })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    t(c.history.restoreConfirm, { version: 1 }),
  );
  await dialog.getByRole("button", { name: c.history.restore }).click();
  await expect(
    page.locator('.custom-api-history li[data-version="3"]'),
  ).toContainText(t(c.history.sameAs, { version: 1 }));

  // Export: the definition only, no login.
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: c.export.button }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("shop-api.netrics-api.json");
  const path = await download.path();
  const text = readFileSync(path, "utf8");
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(connectionId);
  expect(text).not.toContain(workspaceId);
  const file = JSON.parse(text) as Record<string, unknown>;
  expect(file).toMatchObject({
    format: "netrics.custom-api-definition",
    schemaVersion: 2,
  });

  // Import it in another workspace, connect it there (exit gate 5 in
  // miniature).
  const other = await startWorkspace(page, locale);
  await page.goto(`/workspaces/${other.workspaceId}/custom-apis`);
  await page.locator("#custom-api-import-file").setInputFiles(path);
  await page.getByRole("button", { name: c.import.button }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${other.workspaceId}/custom-apis/[0-9a-f-]{36}$`),
  );
  await page.getByRole("link", { name: c.list.connect, exact: true }).click();
  await page.locator("#custom-api-connect-secret-token").fill(TOKEN);
  await page.getByRole("button", { name: c.connect.submit }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${other.workspaceId}/connections/[0-9a-f-]{36}`),
  );
  await expect(page.getByText("Shop API").first()).toBeVisible();
  await noToken(page);
});

/**
 * A custom API connection's plain values are edited on its connection page
 * (#830), not only through a definition update; its login stays.
 */
test("a member changes a custom API connection's values on its page", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const w = (locale === "de" ? workspaceDe : workspaceEn) as typeof workspaceEn;
  const { workspaceId } = await startWorkspace(page, locale);
  const base = `/v1/workspaces/${workspaceId}/custom-api/definitions`;
  const created = await page.request.post(base, {
    headers: { origin: ORIGIN },
    data: {
      document: {
        ...shopDocument(false),
        variables: [{ id: "shop", label: "Shop", secret: false }],
      },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const definitionId = (
    (await created.json()) as { definition: { id: string } }
  ).definition.id;
  const connected = await page.request.post(
    `${base}/${definitionId}/connections`,
    {
      headers: { origin: ORIGIN },
      data: {
        name: "Shop API",
        environmentId: "production",
        variables: { shop: "north" },
        credentials: { token: TOKEN },
      },
    },
  );
  expect(connected.status(), await connected.text()).toBe(201);
  const connectionId = (
    (await connected.json()) as { connection: { id: string } }
  ).connection.id;

  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);
  const value = page.locator("#config-shop");
  await expect(value).toHaveValue("north");
  await value.fill("south");
  await page
    .getByRole("button", { name: w.connections.edit.saveChanges })
    .click();
  await expect(page.getByText(w.connections.edit.updated)).toBeVisible();
  await page.reload();
  await expect(page.locator("#config-shop")).toHaveValue("south");
  const stored = await page.request.get(
    `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
  );
  expect(
    ((await stored.json()) as { connection: { config: unknown } }).connection
      .config,
  ).toEqual({ shop: "south" });
  await noToken(page);
});

/**
 * ADR 0030: a connection shows what it sends to everyone who can see it,
 * the POST bodies included, with the JSON body's read-only note.
 */
test("a connection shows its POST and GraphQL requests", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const c = labels(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const base = `/v1/workspaces/${workspaceId}/custom-api/definitions`;
  const shop = shopDocument(true);
  const query =
    "query Items($first: Int!, $after: String) { items(first: $first, after: $after) { nodes { id } pageInfo { endCursor } } }";
  const itemFields = [
    { id: "id", name: "ID", path: "id", type: "integer", nullable: false },
  ];
  const document = {
    ...shop,
    schemaVersion: 2,
    streams: [
      ...shop.streams,
      {
        key: "graphql_items",
        name: "GraphQL items",
        request: {
          method: "POST",
          path: "/graphql/string-cursor",
          body: {
            kind: "graphql",
            query,
            variables: { first: 10, after: null },
          },
        },
        pagination: {
          type: "cursor",
          cursorPath: "data.items.pageInfo.endCursor",
          bodyPath: "variables.after",
        },
        records: "data.items.nodes",
        fields: itemFields,
        keyFields: ["id"],
        mode: "snapshot",
      },
      {
        key: "query_items",
        name: "Query items",
        request: {
          method: "POST",
          path: "/query",
          body: {
            kind: "json",
            value: { kind: "ItemsQuery", page: { offset: 0, limit: 0 } },
            readOnlyConfirmed: true,
          },
        },
        pagination: {
          type: "offset",
          offsetBodyPath: "page.offset",
          limitBodyPath: "page.limit",
          limit: 10,
        },
        records: "items",
        fields: itemFields,
        keyFields: ["id"],
        mode: "snapshot",
      },
    ],
  };
  const created = await page.request.post(base, {
    headers: { origin: ORIGIN },
    data: { document },
  });
  expect(created.status(), await created.text()).toBe(201);
  const definitionId = (
    (await created.json()) as { definition: { id: string } }
  ).definition.id;
  const connected = await page.request.post(
    `${base}/${definitionId}/connections`,
    {
      headers: { origin: ORIGIN },
      data: {
        name: "Shop API",
        environmentId: "production",
        credentials: { token: TOKEN },
      },
    },
  );
  expect(connected.status(), await connected.text()).toBe(201);
  const connectionId = (
    (await connected.json()) as { connection: { id: string } }
  ).connection.id;

  await page.goto(`/workspaces/${workspaceId}/connections/${connectionId}`);
  const requests = page.locator("#custom-api-requests");
  await expect(
    requests.getByRole("heading", { name: c.connectionRequests.title }),
  ).toBeVisible();
  await expect(
    requests.getByTestId("custom-api-request-daily_stats"),
  ).toContainText("GET /builder/stats");
  const graphql = requests.getByTestId("custom-api-request-graphql_items");
  await expect(graphql).toContainText("POST /graphql/string-cursor");
  await expect(graphql).toContainText(c.connectionRequests.graphql);
  await expect(graphql).toContainText(query);
  const json = requests.getByTestId("custom-api-request-query_items");
  await expect(json).toContainText("POST /query");
  await expect(json).toContainText(c.connectionRequests.jsonReadOnly);
  await expect(json).toContainText('"kind": "ItemsQuery"');
  await noToken(page);
});

/**
 * ADR 0030 §2 in the editor: testing a saved JSON-body POST stream shows
 * the exact request and sends it only after "this request only reads
 * data"; the method and body stay POST.
 */
test("a member confirms a JSON-body POST test before it is sent", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const c = labels(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  const base = `/v1/workspaces/${workspaceId}/custom-api/definitions`;
  const created = await page.request.post(base, {
    headers: { origin: ORIGIN },
    data: {
      document: {
        schemaVersion: 2,
        name: "Query API",
        environments: [
          { id: "production", name: "Production", baseUrl: CUSTOM_API_ORIGIN },
        ],
        auth: { type: "none" },
        streams: [
          {
            key: "query_items",
            name: "Query items",
            request: {
              method: "POST",
              path: "/query",
              body: {
                kind: "json",
                value: { kind: "ItemsQuery", page: { offset: 0, limit: 0 } },
                readOnlyConfirmed: true,
              },
            },
            pagination: {
              type: "offset",
              offsetBodyPath: "page.offset",
              limitBodyPath: "page.limit",
              limit: 10,
            },
            records: "items",
            fields: [
              {
                id: "id",
                name: "ID",
                path: "id",
                type: "integer",
                nullable: false,
              },
            ],
            keyFields: ["id"],
            mode: "snapshot",
          },
        ],
      },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const definitionId = (
    (await created.json()) as { definition: { id: string } }
  ).definition.id;

  await page.goto(`/workspaces/${workspaceId}/custom-apis/${definitionId}`);
  await page
    .locator(".custom-api-stepper")
    .getByRole("button", { name: c.steps.request })
    .click();
  await expect(
    page.getByRole("heading", { name: c.steps.request }),
  ).toBeVisible();
  // The saved method and body load into the editor (#869).
  await expect(page.getByLabel("POST", { exact: true })).toBeChecked();
  await expect(page.locator("#custom-api-body-json")).toHaveValue(
    /"kind": "ItemsQuery"/,
  );
  await page.getByRole("button", { name: c.request.send }).click();

  // Nothing is sent before the confirmation.
  const confirm = page.getByTestId("custom-api-read-only");
  await expect(confirm).toContainText(c.test.readOnly.title);
  await expect(confirm).toContainText(`POST ${CUSTOM_API_ORIGIN}/query`);
  await expect(confirm).toContainText('"kind": "ItemsQuery"');
  const send = confirm.getByRole("button", { name: c.test.readOnly.send });
  await expect(send).toBeDisabled();
  await confirm.getByLabel(c.test.readOnly.confirm).check();
  await send.click();

  await expect(page.getByText(c.test.ok)).toBeVisible();
  const log = page.locator(".custom-api-log-entry");
  await expect(log).toHaveCount(1);
  await expect(log.first().locator("td").nth(2)).toHaveText("200");
  await expect(page.getByTestId("custom-api-read-only")).toHaveCount(0);
});

/** A new builder up to its Request step, without a login (#869). */
async function newRequest(page: Page, locale: Locale, name: string) {
  const c = labels(locale);
  const s = sources(locale);
  const { workspaceId } = await startWorkspace(page, locale);
  await page.goto(`/workspaces/${workspaceId}/sources`);
  await page.getByRole("link", { name: s.customApi.buildName }).click();
  await page.locator("#custom-api-name").fill(name);
  await page.locator("#custom-api-base-url-0").fill(CUSTOM_API_ORIGIN);
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: c.steps.login }),
  ).toBeVisible();
  await page.getByLabel(c.login.methods.none).check();
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: c.steps.request }),
  ).toBeVisible();
  return workspaceId;
}

/** Opens a collapsed node of the response tree. */
async function expand(page: Page, path: string) {
  await page
    .locator(`[data-path="${path}"] > .json-tree-toggle`)
    .first()
    .click();
}

/**
 * #869: a member authors a GraphQL POST stream in the builder. The
 * read-only check shows as the query is typed (a mutation is refused),
 * the test sends it without a confirmation, the cursor goes into the
 * variables, and the saved connection shows the query.
 */
test("a member builds a GraphQL POST stream", async ({ page }, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const c = labels(locale);
  const workspaceId = await newRequest(page, locale, "GraphQL API");

  await page.locator("#custom-api-path").fill("/graphql/string-cursor");
  await page.getByLabel("POST", { exact: true }).check();
  await page.getByLabel(c.request.bodyKinds.graphql).check();
  const query = page.locator("#custom-api-graphql-query");
  const check = page.getByTestId("custom-api-graphql-check");
  await query.fill("mutation { deleteItems }");
  await expect(check).toHaveText(c.request.graphqlCheck.not_query);
  await expect(query).toHaveAttribute("aria-invalid", "true");
  await query.fill(
    "query Items($first: Int!, $after: String) { items(first: $first, after: $after) { nodes { id name } pageInfo { endCursor } } }",
  );
  await expect(check).toHaveText(c.request.graphqlCheck.ok);
  await page
    .locator("#custom-api-graphql-variables")
    .fill('{ "first": 10, "after": null }');
  await page.getByRole("button", { name: c.request.send }).click();
  // A GraphQL query needs no read-only confirmation: its check holds.
  await expect(page.getByText(c.test.ok)).toBeVisible();
  await expect(page.getByTestId("custom-api-read-only")).toHaveCount(0);
  const log = page.locator(".custom-api-log-entry");
  await expect(log.first().locator("td").nth(2)).toHaveText("200");
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  await expect(
    page.getByRole("heading", { name: c.steps.response }),
  ).toBeVisible();
  await expand(page, "data.items");
  await page.locator('[data-pick="data.items.nodes"]').click();
  for (const path of ["id", "name"])
    await page.getByRole("checkbox", { name: path, exact: true }).check();
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  // Paging: the cursor goes into the variables, never a URL parameter.
  await expect(
    page.getByRole("heading", { name: c.steps.paging }),
  ).toBeVisible();
  await expect(page.getByLabel(c.paging.styles.next_url)).toHaveCount(0);
  await page.getByLabel(c.paging.styles.cursor).check();
  const placement = page.getByTestId("custom-api-cursor-placement");
  await placement.getByLabel(c.paging.placement.body).check();
  await expect(page.locator("#custom-api-cursor-param")).toHaveCount(0);
  await page
    .locator("#custom-api-cursor-body-path")
    .selectOption("variables.after");
  await expand(page, "data.items");
  await expand(page, "data.items.pageInfo");
  await page.locator('[data-pick="data.items.pageInfo.endCursor"]').click();
  await page.getByRole("button", { name: c.paging.test }).click();
  await expect(
    page.getByText(
      formatMessage(locale, c.paging.fetched, { pages: 3, records: 25 }),
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  await expect(
    page.getByRole("heading", { name: c.steps.review }),
  ).toBeVisible();
  await expect(page.getByTestId("custom-api-read-only-save")).toHaveCount(0);
  await page.getByRole("button", { name: c.review.save }).click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/connections/[0-9a-f-]{36}$`),
  );
  const requests = page.locator("#custom-api-requests");
  await expect(requests).toContainText("POST /graphql/string-cursor");
  await expect(requests).toContainText(c.connectionRequests.graphql);
});

/**
 * #869: a member authors a JSON-body POST stream. A test confirmation goes
 * stale when the body changes; the offset and limit go into the body; and
 * the version is saved only after the save-time confirmation of the exact
 * request.
 */
test("a member builds a JSON POST stream and confirms it at save", async ({
  page,
}, testInfo) => {
  const locale = testInfo.project.name as Locale;
  const c = labels(locale);
  const workspaceId = await newRequest(page, locale, "Query API");

  await page.locator("#custom-api-path").fill("/query");
  await page.getByLabel("POST", { exact: true }).check();
  const body = page.locator("#custom-api-body-json");
  await body.fill('{ "kind": "ItemsQuery", "page": ');
  await expect(body).toHaveAttribute("aria-invalid", "true");
  await body.fill(
    '{ "kind": "ItemsQuery", "page": { "offset": 0, "limit": 5 } }',
  );
  await expect(body).not.toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: c.request.send }).click();
  const confirm = page.getByTestId("custom-api-read-only");
  await expect(confirm).toContainText(`POST ${CUSTOM_API_ORIGIN}/query`);

  // Changing the body while asked drops the question: nothing is sent.
  await body.fill(
    '{ "kind": "ItemsQuery", "page": { "offset": 0, "limit": 10 } }',
  );
  await expect(confirm).toHaveCount(0);
  await expect(page.getByText(c.test.readOnly.changed)).toBeVisible();
  await page.getByRole("button", { name: c.request.send }).click();
  await expect(confirm).toContainText('"limit": 10');
  await confirm.getByLabel(c.test.readOnly.confirm).check();
  await confirm.getByRole("button", { name: c.test.readOnly.send }).click();
  await expect(page.getByText(c.test.ok)).toBeVisible();
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  await expect(
    page.getByRole("heading", { name: c.steps.response }),
  ).toBeVisible();
  await page.locator('[data-pick="items"]').click();
  for (const path of ["id", "name"])
    await page.getByRole("checkbox", { name: path, exact: true }).check();
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  // Paging: offset and limit replace values of the body.
  await expect(
    page.getByRole("heading", { name: c.steps.paging }),
  ).toBeVisible();
  await page.getByLabel(c.paging.styles.offset).check();
  for (const [value, path] of [
    ["offset", "page.offset"],
    ["limit", "page.limit"],
  ] as const) {
    await page
      .getByTestId(`custom-api-${value}-placement`)
      .getByLabel(c.paging.placement.body)
      .check();
    await page.locator(`#custom-api-${value}-body-path`).selectOption(path);
  }
  await page.locator("#custom-api-limit").fill("10");
  await page.getByRole("button", { name: c.paging.test }).click();
  // The paging changed the request: it is confirmed again before sending.
  await expect(confirm).toContainText("page.offset");
  await confirm.getByLabel(c.test.readOnly.confirm).check();
  await confirm.getByRole("button", { name: c.test.readOnly.send }).click();
  await expect(page.locator(".custom-api-fetched")).toBeVisible();
  await page.getByRole("button", { name: c.nav.continue, exact: true }).click();

  // Save: only after confirming the exact request this version saves.
  await expect(
    page.getByRole("heading", { name: c.steps.review }),
  ).toBeVisible();
  const save = page.getByRole("button", { name: c.review.save });
  await expect(save).toBeDisabled();
  await expect(page.getByText(c.issues.readOnlyUnconfirmed)).toBeVisible();
  const saveConfirm = page.getByTestId("custom-api-read-only-save");
  await expect(saveConfirm).toContainText(`POST ${CUSTOM_API_ORIGIN}/query`);
  await expect(saveConfirm).toContainText('"kind": "ItemsQuery"');
  await saveConfirm.getByRole("checkbox").check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page).toHaveURL(
    new RegExp(`/workspaces/${workspaceId}/connections/[0-9a-f-]{36}$`),
  );
  const requests = page.locator("#custom-api-requests");
  await expect(requests).toContainText("POST /query");
  await expect(requests).toContainText(c.connectionRequests.jsonReadOnly);
});
