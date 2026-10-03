import {
  createDatabase,
  createRawSqlClient,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildDeviceDashboard } from "./devices/dashboard.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// The studio migration (ADR 0015 section 4) on dashboards written in the
// previous shape: a screen that still asks for schema 1 must get exactly the
// payload it got before, byte for byte, so its ETag does not even change.
// The expected strings were recorded on the code before the migration.

const LAST_BEFORE = "0032_longer_periods";
const NOW = new Date("2026-10-04T10:00:00Z");

let testDb: TestDatabase;
let owner: Sql;
let db: Database;
let workspaceId: string;
let rich: string;
let large: string;
let empty: string;
let deviceIds: string[];

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
  owner = createRawSqlClient(testDb.adminUrl, {
    max: 1,
    onnotice: () => undefined,
  });

  await owner`insert into connectors (id, version, manifest) values
    ('snap', '1.0.0', ${owner.json({ id: "snap" })})`;
  await owner`
    insert into metric_definitions (connector_id, key, name, description,
      kind, unit, granularity, dimensions, aggregations)
    values
      ('snap', 'snap.downloads', 'Downloads', '', 'delta', 'count', 'day',
       '["resource"]', '["sum","avg","min","max"]'),
      ('snap', 'snap.proceeds', 'Proceeds', '', 'delta', 'currency_minor',
       'day', '["resource","currency"]', '["sum"]'),
      ('snap', 'snap.rating', 'Rating', '', 'gauge', 'rating', 'day',
       '["resource"]', '["last","avg"]')`;
  const [workspace] = await owner`
    insert into workspaces (name, time_zone, display_currency)
    values ('W', 'Europe/Berlin', 'EUR') returning id`;
  workspaceId = workspace!.id as string;
  const [connection] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'snap', 'Store') returning id`;
  const connectionId = connection!.id as string;
  await owner`
    insert into connection_state (connection_id, workspace_id,
      last_success_at, poll_interval_seconds)
    values (${connectionId}, ${workspaceId}, '2026-10-04T09:55:00Z', 300)`;
  await owner`
    insert into connection_resources (connection_id, workspace_id,
      resource_id, name, kind)
    values (${connectionId}, ${workspaceId}, 'app-1', 'Wurfel', 'app'),
           (${connectionId}, ${workspaceId}, 'app-2', 'voilà', 'app')`;
  await owner`
    insert into exchange_rates (rate_date, currency, units_per_eur)
    values ('2026-10-02', 'USD', '1.25')`;

  const observe = (
    key: string,
    date: string,
    value: number,
    dimensions: Record<string, string>,
  ) => owner`
    insert into observations (workspace_id, connection_id,
      metric_definition_id, dimensions, source_timestamp, value)
    select ${workspaceId}, ${connectionId}, m.id, ${owner.json(dimensions)},
           ${`${date}T00:00:00Z`}::timestamptz, ${value}
    from metric_definitions m
    where m.connector_id = 'snap' and m.key = ${key}`;
  for (let day = 1; day <= 4; day++) {
    const date = `2026-10-0${day}`;
    await observe("snap.downloads", date, 10 * day, { resource: "app-1" });
    await observe("snap.downloads", date, day, { resource: "app-2" });
    await observe("snap.proceeds", date, 1_000 * day, {
      resource: "app-1",
      currency: "EUR",
    });
    await observe("snap.proceeds", date, 500 * day, {
      resource: "app-1",
      currency: "USD",
    });
    await observe("snap.rating", date, 4 + day / 10, { resource: "app-1" });
  }

  // Fixed ids: they are part of the recorded payloads.
  const dashboard = async (name: string, id: string) => {
    const [row] = await owner`
      insert into dashboards (id, workspace_id, name)
      values (${id}, ${workspaceId}, ${name}) returning id`;
    return row!.id as string;
  };
  const tile = (
    dashboardId: string,
    position: number,
    fields: {
      metricKey?: string;
      aggregation?: string;
      period?: string;
      dimensions?: Record<string, string>;
      title?: string | null;
      displayCurrency?: string | null;
    } = {},
  ) => owner`
    insert into dashboard_tiles (id, dashboard_id, workspace_id,
      connection_id, metric_key, aggregation, period, dimensions, title,
      display_currency, position)
    values (
      ${`00000000-0000-4000-8000-${String(position).padStart(6, "0")}${dashboardId.slice(-6)}`},
      ${dashboardId}, ${workspaceId}, ${connectionId},
      ${fields.metricKey ?? "snap.downloads"}, ${fields.aggregation ?? "sum"},
      ${fields.period ?? "last_7_days"}, ${owner.json(fields.dimensions ?? {})},
      ${fields.title ?? null}, ${fields.displayCurrency ?? null},
      ${position})`;

  rich = await dashboard("Wurfel wall", "11111111-1111-4111-8111-111111111111");
  // Positions with a gap, as a deleted tile could leave them.
  await tile(rich, 0, { title: "All downloads" });
  await tile(rich, 1, { dimensions: { resource: "app-1" } });
  await tile(rich, 3, {
    metricKey: "snap.proceeds",
    dimensions: { resource: "app-1", currency: "USD" },
  });
  await tile(rich, 4, {
    metricKey: "snap.proceeds",
    displayCurrency: "USD",
    period: "this_month",
  });
  await tile(rich, 5, { metricKey: "snap.proceeds", period: "today" });
  await tile(rich, 6, {
    metricKey: "snap.rating",
    aggregation: "last",
    dimensions: { resource: "app-1" },
    title: "Rating · Wurfel",
  });
  await tile(rich, 7, { aggregation: "avg", period: "last_12_months" });

  large = await dashboard("Everything", "22222222-2222-4222-8222-222222222222");
  for (let position = 0; position < 17; position++) {
    await tile(large, position, {
      period: position % 2 === 0 ? "today" : "last_30_days",
      dimensions: position % 3 === 0 ? { resource: "app-2" } : {},
    });
  }
  empty = await dashboard("Empty", "33333333-3333-4333-8333-333333333333");

  deviceIds = [];
  for (const [index, dashboardId] of [rich, large, empty].entries()) {
    const [device] = await owner`
      insert into devices (workspace_id, name, dashboard_id)
      values (${workspaceId}, ${`TV ${index}`}, ${dashboardId})
      returning id`;
    deviceIds.push(device!.id as string);
  }

  await testDb.migrate();
  db = createDatabase(testDb.appUrl, { max: 2 });
}, 60_000);

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
});

function payload(dashboardId: string | null) {
  return withWorkspace(db, { workspaceId }, (tx) =>
    buildDeviceDashboard(tx, workspaceId, dashboardId, {
      now: NOW,
      exchangeRates: true,
    }),
  );
}

describe("device payload schema 1 after the studio migration", () => {
  it("is byte-identical for a dashboard of seven varied tiles", async () => {
    expect(JSON.stringify(await payload(rich))).toMatchInlineSnapshot(
      `"{"version":"QhhxN7Br7x7Ez6f4opubygYCvigZ9v4_","refreshAfterSec":60,"timeZone":"Europe/Berlin","dashboard":{"id":"11111111-1111-4111-8111-111111111111","name":"Wurfel wall"},"tiles":[{"id":"00000000-0000-4000-8000-000000111111","label":"All downloads","period":"last_7_days","aggregation":"sum","value":110,"unit":"count","conversion":null,"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[null,null,null,11,22,33,44],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000001111111","label":"Downloads · Wurfel","period":"last_7_days","aggregation":"sum","value":100,"unit":"count","conversion":null,"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[null,null,null,10,20,30,40],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000003111111","label":"Proceeds · Wurfel","period":"last_7_days","aggregation":"sum","value":5000,"unit":"USD_minor","conversion":null,"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[null,null,null,500,1000,1500,2000],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000004111111","label":"Proceeds · All resources","period":"this_month","aggregation":"sum","value":16250,"unit":"USD_minor","conversion":{"displayCurrency":"USD","source":"ECB euro foreign exchange reference rates","unconverted":[{"currency":"EUR","value":1000}]},"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[500,3500,5250,7000],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000005111111","label":"Proceeds · All resources","period":"today","aggregation":"sum","value":5600,"unit":"EUR_minor","conversion":{"displayCurrency":"EUR","source":"ECB euro foreign exchange reference rates","unconverted":[]},"change":{"previousValue":4200,"delta":1400,"ratio":0.3333333333333333},"spark":[5600],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000006111111","label":"Rating · Wurfel","period":"last_7_days","aggregation":"last","value":4.4,"unit":"rating","conversion":null,"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[null,null,null,4.1,4.2,4.3,4.4],"kind":"gauge","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000007111111","label":"Downloads · All resources","period":"last_12_months","aggregation":"avg","value":27.5,"unit":"count","conversion":null,"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[null,null,null,null,null,null,null,null,null,null,null,27.5],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"}]}"`,
    );
  });

  it("is byte-identical for a dashboard of 17 tiles", async () => {
    expect(JSON.stringify(await payload(large))).toMatchInlineSnapshot(
      `"{"version":"pyrnVpFCFq95-fvNGfMnNa-ZrR33QBeE","refreshAfterSec":60,"timeZone":"Europe/Berlin","dashboard":{"id":"22222222-2222-4222-8222-222222222222","name":"Everything"},"tiles":[{"id":"00000000-0000-4000-8000-000000222222","label":"Downloads · voilà","period":"today","aggregation":"sum","value":4,"unit":"count","conversion":null,"change":{"previousValue":3,"delta":1,"ratio":0.3333333333333333},"spark":[4],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000001222222","label":"Downloads · All resources","period":"last_30_days","aggregation":"sum","value":110,"unit":"count","conversion":null,"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,11,22,33,44],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000002222222","label":"Downloads · All resources","period":"today","aggregation":"sum","value":44,"unit":"count","conversion":null,"change":{"previousValue":33,"delta":11,"ratio":0.3333333333333333},"spark":[44],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000003222222","label":"Downloads · voilà","period":"last_30_days","aggregation":"sum","value":10,"unit":"count","conversion":null,"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,1,2,3,4],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000004222222","label":"Downloads · All resources","period":"today","aggregation":"sum","value":44,"unit":"count","conversion":null,"change":{"previousValue":33,"delta":11,"ratio":0.3333333333333333},"spark":[44],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000005222222","label":"Downloads · All resources","period":"last_30_days","aggregation":"sum","value":110,"unit":"count","conversion":null,"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,11,22,33,44],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000006222222","label":"Downloads · voilà","period":"today","aggregation":"sum","value":4,"unit":"count","conversion":null,"change":{"previousValue":3,"delta":1,"ratio":0.3333333333333333},"spark":[4],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000007222222","label":"Downloads · All resources","period":"last_30_days","aggregation":"sum","value":110,"unit":"count","conversion":null,"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,11,22,33,44],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000008222222","label":"Downloads · All resources","period":"today","aggregation":"sum","value":44,"unit":"count","conversion":null,"change":{"previousValue":33,"delta":11,"ratio":0.3333333333333333},"spark":[44],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000009222222","label":"Downloads · voilà","period":"last_30_days","aggregation":"sum","value":10,"unit":"count","conversion":null,"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,1,2,3,4],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000010222222","label":"Downloads · All resources","period":"today","aggregation":"sum","value":44,"unit":"count","conversion":null,"change":{"previousValue":33,"delta":11,"ratio":0.3333333333333333},"spark":[44],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000011222222","label":"Downloads · All resources","period":"last_30_days","aggregation":"sum","value":110,"unit":"count","conversion":null,"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,11,22,33,44],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000012222222","label":"Downloads · voilà","period":"today","aggregation":"sum","value":4,"unit":"count","conversion":null,"change":{"previousValue":3,"delta":1,"ratio":0.3333333333333333},"spark":[4],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000013222222","label":"Downloads · All resources","period":"last_30_days","aggregation":"sum","value":110,"unit":"count","conversion":null,"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,11,22,33,44],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000014222222","label":"Downloads · All resources","period":"today","aggregation":"sum","value":44,"unit":"count","conversion":null,"change":{"previousValue":33,"delta":11,"ratio":0.3333333333333333},"spark":[44],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000015222222","label":"Downloads · voilà","period":"last_30_days","aggregation":"sum","value":10,"unit":"count","conversion":null,"change":{"previousValue":null,"delta":null,"ratio":null},"spark":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,1,2,3,4],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"},{"id":"00000000-0000-4000-8000-000016222222","label":"Downloads · All resources","period":"today","aggregation":"sum","value":44,"unit":"count","conversion":null,"change":{"previousValue":33,"delta":11,"ratio":0.3333333333333333},"spark":[44],"kind":"delta","granularity":"day","better":"higher","status":"ok","updatedAt":"2026-10-04T09:55:00.000Z"}]}"`,
    );
  });

  it("is byte-identical for an empty dashboard and for none", async () => {
    expect(JSON.stringify(await payload(empty))).toMatchInlineSnapshot(
      `"{"version":"6vNGQWfRbdK1Y7qhgIytfAXuSxeCrQaO","refreshAfterSec":60,"timeZone":"Europe/Berlin","dashboard":{"id":"33333333-3333-4333-8333-333333333333","name":"Empty"},"tiles":[]}"`,
    );
    expect(JSON.stringify(await payload(null))).toMatchInlineSnapshot(
      `"{"version":"Rwt-U-WeirU77GZhtADNupMnEZ-KJM_a","refreshAfterSec":60,"timeZone":"Europe/Berlin","dashboard":null,"tiles":[]}"`,
    );
  });

  it("keeps every device on its dashboard", async () => {
    const rows = await owner`
      select dashboard_id from devices where id in ${owner(deviceIds)}
      order by name`;
    expect(rows.map((row) => row.dashboard_id)).toEqual([rich, large, empty]);
  });
});
