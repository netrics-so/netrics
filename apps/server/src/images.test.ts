import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPairingResponseSchema,
  dashboardResponseSchema,
  imageInUseResponseSchema,
  pollPairingResponseSchema,
  IMAGE_MAX_BYTES,
  IMAGE_NAME_HEADER,
  errorResponseSchema,
  imageListResponseSchema,
  imageResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { capturingLogger } from "./oauth/test-provider.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import { createTestDatabase } from "./test-db.js";

// Workspace images over HTTP (#217, ADR 0015 section 5).

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

function fixture(name: string): Buffer {
  return readFileSync(new URL(`./images/fixtures/${name}`, import.meta.url));
}

let app: FastifyInstance;
let db: Database;
let admin: Sql;
const logs: string[] = [];
let owner: string;
let viewer: string;
let stranger: string;
let workspaceId: string;
let otherWorkspaceId: string;

async function signUp(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: email, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  return cookies
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

async function newWorkspace(cookie: string, name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie },
    payload: { name },
  });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

function upload(
  cookie: string,
  body: Buffer | string,
  contentType: string,
  options: { workspace?: string; name?: string } = {},
): Promise<InjectResponse> {
  return app.inject({
    method: "POST",
    url: `/v1/workspaces/${options.workspace ?? workspaceId}/images`,
    headers: {
      cookie,
      "content-type": contentType,
      ...(options.name !== undefined
        ? { [IMAGE_NAME_HEADER]: encodeURIComponent(options.name) }
        : {}),
    },
    payload: body,
  });
}

async function uploaded(
  cookie: string,
  body: Buffer,
  contentType: string,
  options: { workspace?: string; name?: string } = {},
) {
  const response = await upload(cookie, body, contentType, options);
  expect(response.statusCode, response.body).toBe(200);
  return imageResponseSchema.parse(response.json()).image;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, crc]);
}

/** A valid RGB PNG of random pixels, stored without compression. */
function noisePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let index = 0; index < rows.length; index += 1) {
    rows[index] = index % (width * 3 + 1) === 0 ? 0 : (index * 7919) & 0xff;
  }
  return Buffer.concat([
    fixture("plain.png").subarray(0, 8),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows, { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function get(
  cookie: string,
  url: string,
  headers: Record<string, string> = {},
) {
  return app.inject({ method: "GET", url, headers: { cookie, ...headers } });
}

function expectError(response: InjectResponse, status: number, error: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(errorResponseSchema.parse(response.json()).error).toBe(error);
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "debug",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    NETRICS_IMAGE_QUOTA_COUNT: "30",
    NETRICS_IMAGE_QUOTA_MIB: "2",
  });
  db = createDatabase(testDb.appUrl);
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    checkDb: async () => true,
    logger: capturingLogger(logs),
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  owner = await signUp("images-owner@example.com");
  viewer = await signUp("images-viewer@example.com");
  stranger = await signUp("images-stranger@example.com");
  workspaceId = await newWorkspace(owner, "Images");
  otherWorkspaceId = await newWorkspace(stranger, "Elsewhere");
  const added = await addMemberViaInvitation(
    app,
    db,
    owner,
    workspaceId,
    "images-viewer@example.com",
    "viewer",
  );
  expect(added.statusCode).toBe(200);
});

afterAll(async () => {
  await app.close();
  await admin.end({ timeout: 5 });
  await db.$client.end({ timeout: 5 });
});

describe("upload", () => {
  it("stores a PNG, JPEG and WebP with type, size, dimensions and hash", async () => {
    for (const [name, type] of [
      ["plain.png", "image/png"],
      ["plain.jpg", "image/jpeg"],
      ["lossless.webp", "image/webp"],
    ] as const) {
      const image = await uploaded(owner, fixture(name), type, { name });
      expect(image).toMatchObject({
        name,
        contentType: type,
        width: 24,
        height: 16,
        bytes: fixture(name).length,
        sha256: createHash("sha256").update(fixture(name)).digest("hex"),
        origin: "upload",
        connectionId: null,
        resourceId: null,
      });
      expect(image.url).toBe(
        `/v1/workspaces/${workspaceId}/images/${image.id}/content?v=${image.sha256}`,
      );
      const content = await get(owner, image.url);
      expect(content.statusCode).toBe(200);
      expect(content.rawPayload).toEqual(fixture(name));
      await admin`delete from workspace_images where id = ${image.id}`;
    }
  });

  it("stores a JPEG without its EXIF GPS data, pixels unchanged", async () => {
    const source = fixture("gps.jpg");
    const image = await uploaded(owner, source, "image/jpeg", {
      name: "holiday.jpg",
    });
    expect(image.bytes).toBeLessThan(source.length);
    const content = (await get(owner, image.url)).rawPayload;
    expect(content.includes("Exif")).toBe(false);
    expect(content.includes("GPS")).toBe(false);
    expect(content.includes("secret")).toBe(false);
    // The entropy-coded data from the first scan on is untouched.
    const scan = (input: Buffer) =>
      input.subarray(input.indexOf(Buffer.from([0xff, 0xda])));
    expect(scan(content)).toEqual(scan(source));
    const [row] = await admin`
      select content from workspace_images where id = ${image.id}`;
    expect(Buffer.from(row!.content as Uint8Array)).toEqual(content);
    await admin`delete from workspace_images where id = ${image.id}`;
  });

  it("stores a PNG without its text chunks", async () => {
    const image = await uploaded(owner, fixture("metadata.png"), "image/png");
    const content = (await get(owner, image.url)).rawPayload;
    expect(content.includes("tEXt")).toBe(false);
    expect(content.includes("Jane")).toBe(false);
    expect(content.includes("iCCP")).toBe(true);
    expect(image.name).toBe("image");
    await admin`delete from workspace_images where id = ${image.id}`;
  });

  it("refuses SVG, HTML and other types by Content-Type (415)", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    expectError(
      await upload(owner, svg, "image/svg+xml"),
      415,
      "unsupported_media_type",
    );
    expectError(
      await upload(owner, "<html></html>", "text/html"),
      415,
      "unsupported_media_type",
    );
    expectError(
      await upload(owner, fixture("animated.png"), "image/gif"),
      415,
      "unsupported_media_type",
    );
    expectError(
      await upload(owner, JSON.stringify({ a: 1 }), "application/json"),
      415,
      "unsupported_media_type",
    );
  });

  it("refuses an SVG renamed to PNG and a PNG/HTML polyglot", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    );
    expectError(
      await upload(owner, svg, "image/png"),
      400,
      "image_type_mismatch",
    );
    const polyglot = Buffer.concat([
      fixture("plain.png").subarray(0, 8),
      Buffer.from("<html><script>alert(1)</script></html>"),
    ]);
    expectError(
      await upload(owner, polyglot, "image/png"),
      400,
      "image_invalid",
    );
  });

  it("refuses an empty body", async () => {
    expectError(
      await upload(owner, Buffer.alloc(0), "image/png"),
      400,
      "image_type_mismatch",
    );
  });

  it("refuses truncated and CRC-broken PNGs", async () => {
    const source = fixture("plain.png");
    expectError(
      await upload(owner, source.subarray(0, source.length - 20), "image/png"),
      400,
      "image_invalid",
    );
    const broken = Buffer.from(source);
    broken[30] = broken[30]! ^ 0xff;
    expectError(await upload(owner, broken, "image/png"), 400, "image_invalid");
  });

  it("refuses animated PNG and WebP", async () => {
    expectError(
      await upload(owner, fixture("animated.png"), "image/png"),
      400,
      "image_animated",
    );
    expectError(
      await upload(owner, fixture("animated.webp"), "image/webp"),
      400,
      "image_animated",
    );
  });

  it("refuses bodies above 1 MiB (413)", async () => {
    const big = Buffer.concat([
      fixture("plain.png"),
      Buffer.alloc(IMAGE_MAX_BYTES),
    ]);
    expectError(
      await upload(owner, big, "image/png"),
      413,
      "payload_too_large",
    );
  });

  it("refuses dimensions above 4096 px from the header", async () => {
    const jpeg = Buffer.from(fixture("plain.jpg"));
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    jpeg.writeUInt16BE(5000, sof + 5);
    expectError(
      await upload(owner, jpeg, "image/jpeg"),
      400,
      "image_dimensions_too_large",
    );
  });

  it("lets only roles with dashboards:update upload", async () => {
    expectError(
      await upload(viewer, fixture("plain.png"), "image/png"),
      403,
      "forbidden",
    );
    expectError(
      await upload(stranger, fixture("plain.png"), "image/png"),
      404,
      "workspace_not_found",
    );
    const anonymous = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/images`,
      headers: { "content-type": "image/png" },
      payload: fixture("plain.png"),
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("refuses an upload from a foreign browser origin", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/images`,
      headers: {
        cookie: owner,
        origin: "https://evil.example",
        "content-type": "image/png",
      },
      payload: fixture("plain.png"),
    });
    expectError(response, 403, "forbidden_origin");
  });
});

describe("quota", () => {
  it("refuses uploads beyond the workspace's image count", async () => {
    const quotaWorkspace = await newWorkspace(owner, "Quota");
    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        upload(owner, fixture("plain.png"), "image/png", {
          workspace: quotaWorkspace,
        }),
      ),
    );
    const statuses = results.map((response) => response.statusCode).sort();
    // 30 fit (NETRICS_IMAGE_QUOTA_COUNT); concurrent uploads cannot both
    // take the last slot.
    expect(statuses).toEqual([...Array(30).fill(200), 409, 409]);
    expectError(
      results.find((r) => r.statusCode === 409)!,
      409,
      "image_quota_exceeded",
    );
    const list = imageListResponseSchema.parse(
      (await get(owner, `/v1/workspaces/${quotaWorkspace}/images`)).json(),
    );
    expect(list.usage).toEqual({
      count: 30,
      bytes: 30 * fixture("plain.png").length,
      maxCount: 30,
      maxBytes: 2 * 1_048_576,
    });
  });

  it("refuses uploads beyond the workspace's total size", async () => {
    const quotaWorkspace = await newWorkspace(owner, "Bytes");
    // 2 MiB quota: two noise PNGs of about 0.86 MiB fit, a third does not.
    const results = [];
    for (let index = 0; index < 3; index += 1) {
      results.push(
        await upload(owner, noisePng(600, 500), "image/png", {
          workspace: quotaWorkspace,
        }),
      );
    }
    expect(results.map((response) => response.statusCode)).toEqual([
      200, 200, 409,
    ]);
    expectError(results[2]!, 409, "image_quota_exceeded");
  });
});

describe("list, content and delete", () => {
  it("lists metadata only, newest first, and never the bytes", async () => {
    const first = await uploaded(owner, fixture("plain.png"), "image/png", {
      name: "first.png",
    });
    const second = await uploaded(owner, fixture("lossy.webp"), "image/webp", {
      name: "second.webp",
    });
    const response = await get(viewer, `/v1/workspaces/${workspaceId}/images`);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const list = imageListResponseSchema.parse(body);
    expect(list.images.map((image) => image.id).slice(0, 2)).toEqual([
      second.id,
      first.id,
    ]);
    expect(JSON.stringify(body)).not.toContain('content"');
    expect(Object.keys(body.images[0])).not.toContain("content");
  });

  it("serves bytes with the security and cache headers, and 304 on the ETag", async () => {
    const image = await uploaded(owner, fixture("plain.png"), "image/png");
    const response = await get(viewer, image.url);
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": 'inline; filename="image.png"',
      "cross-origin-resource-policy": "same-origin",
      etag: `"${image.sha256}"`,
      "cache-control": "private, max-age=31536000, immutable",
    });
    const cached = await get(viewer, image.url, {
      "if-none-match": `"${image.sha256}"`,
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.rawPayload.length).toBe(0);
    expect(cached.headers.etag).toBe(`"${image.sha256}"`);

    const jpeg = await uploaded(owner, fixture("plain.jpg"), "image/jpeg");
    expect((await get(owner, jpeg.url)).headers).toMatchObject({
      "content-type": "image/jpeg",
      "content-disposition": 'inline; filename="image.jpg"',
    });
  });

  it("answers 404 for another version, a malformed id or an unknown image", async () => {
    const image = await uploaded(owner, fixture("plain.png"), "image/png");
    const base = `/v1/workspaces/${workspaceId}/images`;
    expectError(
      await get(owner, `${base}/${image.id}/content?v=${"0".repeat(64)}`),
      404,
      "image_not_found",
    );
    expectError(
      await get(owner, `${base}/not-a-uuid/content`),
      404,
      "image_not_found",
    );
    expectError(
      await get(owner, `${base}/${crypto.randomUUID()}/content`),
      404,
      "image_not_found",
    );
    expect((await get(owner, `${base}/${image.id}/content`)).statusCode).toBe(
      200,
    );
  });

  it("deletes an image (viewer refused) and records audit events without the name", async () => {
    const image = await uploaded(owner, fixture("plain.png"), "image/png", {
      name: "Private Name.png",
    });
    const url = `/v1/workspaces/${workspaceId}/images/${image.id}`;
    expectError(
      await app.inject({ method: "DELETE", url, headers: { cookie: viewer } }),
      403,
      "forbidden",
    );
    const deleted = await app.inject({
      method: "DELETE",
      url,
      headers: { cookie: owner },
    });
    expect(deleted.statusCode).toBe(204);
    expectError(await get(owner, image.url), 404, "image_not_found");
    expectError(
      await app.inject({ method: "DELETE", url, headers: { cookie: owner } }),
      404,
      "image_not_found",
    );
    const events = await admin`
      select action, metadata from audit_events
      where workspace_id = ${workspaceId} and target = ${image.id}
      order by created_at`;
    expect(events.map((event) => event.action)).toEqual([
      "image.uploaded",
      "image.deleted",
    ]);
    expect(events[0]!.metadata).toEqual({
      contentType: "image/png",
      bytes: fixture("plain.png").length,
      width: 24,
      height: 16,
    });
    expect(JSON.stringify(events)).not.toContain("Private");
  });
});

describe("tenant isolation", () => {
  it("never serves, lists or deletes another workspace's image", async () => {
    const foreign = await uploaded(
      stranger,
      fixture("plain.png"),
      "image/png",
      {
        workspace: otherWorkspaceId,
        name: "foreign.png",
      },
    );
    // The owner of the first workspace asks for it through their own.
    const viaOwnWorkspace = `/v1/workspaces/${workspaceId}/images/${foreign.id}`;
    expectError(
      await get(owner, `${viaOwnWorkspace}/content?v=${foreign.sha256}`),
      404,
      "image_not_found",
    );
    expectError(
      await app.inject({
        method: "DELETE",
        url: viaOwnWorkspace,
        headers: { cookie: owner },
      }),
      404,
      "image_not_found",
    );
    const list = imageListResponseSchema.parse(
      (await get(owner, `/v1/workspaces/${workspaceId}/images`)).json(),
    );
    expect(list.images.map((image) => image.id)).not.toContain(foreign.id);
    // And through the foreign workspace's own URL, a non-member gets 404.
    expectError(await get(owner, foreign.url), 404, "workspace_not_found");
    // Still there for its owner.
    expect((await get(stranger, foreign.url)).statusCode).toBe(200);
  });
});

// ─── Dashboards that use images, and device access (#217) ─────────────────

let pairings = 0;

async function newDashboard(
  cookie: string,
  body: Record<string, unknown>,
  workspace = workspaceId,
) {
  return app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspace}/dashboards`,
    headers: { cookie },
    payload: { name: "Brand", ...body },
  });
}

function imageSlides(images: {
  background?: string;
  widget?: string;
  disabledWidget?: string;
}) {
  return [
    {
      name: "Brand",
      ...(images.background
        ? { background: { imageId: images.background, dim: 30 } }
        : {}),
      widgets: images.widget
        ? [
            {
              type: "image",
              x: 0,
              y: 0,
              w: 4,
              h: 4,
              imageId: images.widget,
              options: { fit: "cover" },
            },
          ]
        : [],
    },
    {
      name: "Hidden",
      enabled: false,
      widgets: images.disabledWidget
        ? [
            {
              type: "image",
              x: 0,
              y: 0,
              w: 2,
              h: 2,
              imageId: images.disabledWidget,
            },
          ]
        : [],
    },
  ];
}

/** Pairs a screen to `dashboard` and returns its access token and id. */
async function pairScreen(dashboard: string | null) {
  pairings += 1;
  const started = await app.inject({
    method: "POST",
    url: "/v1/device/pairings",
    remoteAddress: `203.0.113.${pairings}`,
  });
  const pairing = createPairingResponseSchema.parse(started.json());
  const approved = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/devices/approve`,
    headers: { cookie: owner },
    payload: { code: pairing.code, name: "Lobby", dashboardId: dashboard },
  });
  expect(approved.statusCode, approved.body).toBe(200);
  const polled = pollPairingResponseSchema.parse(
    (
      await app.inject({
        method: "POST",
        url: "/v1/device/pairings/poll",
        payload: {
          pairingId: pairing.pairingId,
          pollSecret: pairing.pollSecret,
        },
      })
    ).json(),
  );
  if (polled.status !== "approved") {
    throw new Error("not approved");
  }
  return {
    token: polled.credentials.accessToken,
    deviceId: (approved.json() as { device: { id: string } }).device.id,
  };
}

function deviceGet(token: string, imageId: string, extra = "", headers = {}) {
  return app.inject({
    method: "GET",
    url: `/v1/device/images/${imageId}${extra}`,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
}

describe("dashboards that use images", () => {
  it("stores a logo, a slide background and an image widget", async () => {
    const logo = await uploaded(owner, fixture("plain.png"), "image/png");
    const background = await uploaded(
      owner,
      fixture("plain.jpg"),
      "image/jpeg",
    );
    const widget = await uploaded(owner, fixture("lossy.webp"), "image/webp");
    const created = await newDashboard(owner, {
      settings: { logoImageId: logo.id },
      slides: imageSlides({ background: background.id, widget: widget.id }),
    });
    expect(created.statusCode, created.body).toBe(200);
    const { dashboard } = dashboardResponseSchema.parse(created.json());
    expect(dashboard.settings.logoImageId).toBe(logo.id);
    expect(dashboard.slides[0]!.background).toEqual({
      imageId: background.id,
      dim: 30,
    });
    expect(dashboard.slides[1]!.background).toBeNull();
    expect(dashboard.slides[0]!.widgets).toEqual([
      {
        type: "image",
        id: expect.any(String),
        x: 0,
        y: 0,
        w: 4,
        h: 4,
        title: null,
        imageId: widget.id,
        options: { fit: "cover", align: "center" },
      },
    ]);

    // A copy uses the same images.
    const copy = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/dashboards/${dashboard.id}/duplicate`,
      headers: { cookie: owner },
      payload: {},
    });
    const copied = dashboardResponseSchema.parse(copy.json()).dashboard;
    expect(copied.settings.logoImageId).toBe(logo.id);
    expect(copied.slides[0]!.background?.imageId).toBe(background.id);
    expect(copied.slides[0]!.widgets[0]).toMatchObject({ imageId: widget.id });
  });

  it("refuses images of another workspace or unknown ones (400)", async () => {
    const foreign = await uploaded(
      stranger,
      fixture("plain.png"),
      "image/png",
      {
        workspace: otherWorkspaceId,
      },
    );
    for (const body of [
      { settings: { logoImageId: foreign.id } },
      { slides: imageSlides({ background: foreign.id }) },
      { slides: imageSlides({ widget: foreign.id }) },
      { slides: imageSlides({ widget: crypto.randomUUID() }) },
    ]) {
      expectError(await newDashboard(owner, body), 400, "image_not_found");
    }
  });

  it("refuses to delete an image a dashboard uses (409 with the dashboards)", async () => {
    const image = await uploaded(owner, fixture("plain.png"), "image/png");
    const created = dashboardResponseSchema.parse(
      (
        await newDashboard(owner, {
          name: "Uses it",
          slides: imageSlides({ disabledWidget: image.id }),
        })
      ).json(),
    ).dashboard;
    const url = `/v1/workspaces/${workspaceId}/images/${image.id}`;
    const refused = await app.inject({
      method: "DELETE",
      url,
      headers: { cookie: owner },
    });
    expect(refused.statusCode).toBe(409);
    expect(imageInUseResponseSchema.parse(refused.json())).toEqual({
      error: "image_in_use",
      dashboards: [{ id: created.id, name: "Uses it" }],
    });
    // Still there; free once the dashboard no longer uses it.
    expect((await get(owner, image.url)).statusCode).toBe(200);
    const saved = await app.inject({
      method: "PUT",
      url: `/v1/workspaces/${workspaceId}/dashboards/${created.id}`,
      headers: { cookie: owner },
      payload: {
        version: created.version,
        name: created.name,
        projectId: null,
        slides: imageSlides({}),
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const deleted = await app.inject({
      method: "DELETE",
      url,
      headers: { cookie: owner },
    });
    expect(deleted.statusCode).toBe(204);
  });

  it("refuses the legacy tiles save over a slide with a background", async () => {
    const image = await uploaded(owner, fixture("plain.png"), "image/png");
    const created = dashboardResponseSchema.parse(
      (
        await newDashboard(owner, {
          slides: [{ background: { imageId: image.id }, widgets: [] }],
        })
      ).json(),
    ).dashboard;
    expect(created.slides[0]!.background).toEqual({
      imageId: image.id,
      dim: 40,
    });
    const legacy = await app.inject({
      method: "PUT",
      url: `/v1/workspaces/${workspaceId}/dashboards/${created.id}`,
      headers: { cookie: owner },
      payload: {
        version: created.version,
        name: created.name,
        projectId: null,
        tiles: [],
      },
    });
    expectError(legacy, 409, "studio_dashboard");
  });
});

describe("device access to images", () => {
  it("serves only the images the assigned dashboard shows", async () => {
    const logo = await uploaded(owner, fixture("plain.png"), "image/png");
    const background = await uploaded(
      owner,
      fixture("plain.jpg"),
      "image/jpeg",
    );
    const widget = await uploaded(owner, fixture("lossy.webp"), "image/webp");
    const hidden = await uploaded(
      owner,
      fixture("lossless.webp"),
      "image/webp",
    );
    const unused = await uploaded(owner, fixture("alpha.webp"), "image/webp");
    const foreign = await uploaded(
      stranger,
      fixture("plain.png"),
      "image/png",
      {
        workspace: otherWorkspaceId,
      },
    );
    const dashboard = dashboardResponseSchema.parse(
      (
        await newDashboard(owner, {
          settings: { logoImageId: logo.id },
          slides: imageSlides({
            background: background.id,
            widget: widget.id,
            disabledWidget: hidden.id,
          }),
        })
      ).json(),
    ).dashboard;
    const screen = await pairScreen(dashboard.id);

    for (const image of [logo, background, widget]) {
      const response = await deviceGet(
        screen.token,
        image.id,
        `?v=${image.sha256}`,
      );
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(
        (await get(owner, image.url)).rawPayload,
      );
      expect(response.headers).toMatchObject({
        "content-type": image.contentType,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "same-origin",
        etag: `"${image.sha256}"`,
        "cache-control": "private, max-age=31536000, immutable",
      });
      const cached = await deviceGet(screen.token, image.id, "", {
        "if-none-match": `"${image.sha256}"`,
      });
      expect(cached.statusCode).toBe(304);
    }
    // Not on the dashboard, only on a disabled slide, another workspace's,
    // another version, unknown or malformed: all the same 404.
    for (const [id, extra] of [
      [unused.id, ""],
      [hidden.id, ""],
      [foreign.id, ""],
      [logo.id, `?v=${"0".repeat(64)}`],
      [crypto.randomUUID(), ""],
      ["not-a-uuid", ""],
    ] as const) {
      expectError(
        await deviceGet(screen.token, id, extra),
        404,
        "image_not_found",
      );
    }
  });

  it("follows the device's assignment and refuses other credentials", async () => {
    const image = await uploaded(owner, fixture("plain.png"), "image/png");
    const dashboard = dashboardResponseSchema.parse(
      (
        await newDashboard(owner, { settings: { logoImageId: image.id } })
      ).json(),
    ).dashboard;
    const unassigned = await pairScreen(null);
    expectError(
      await deviceGet(unassigned.token, image.id),
      404,
      "image_not_found",
    );

    const screen = await pairScreen(dashboard.id);
    expect((await deviceGet(screen.token, image.id)).statusCode).toBe(200);
    // Reassigned to a dashboard without the image: gone for this screen.
    const other = dashboardResponseSchema.parse(
      (await newDashboard(owner, {})).json(),
    ).dashboard;
    const moved = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceId}/devices/${screen.deviceId}`,
      headers: { cookie: owner },
      payload: { dashboardId: other.id },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expectError(
      await deviceGet(screen.token, image.id),
      404,
      "image_not_found",
    );

    // A session cookie is not a device credential.
    const withCookie = await app.inject({
      method: "GET",
      url: `/v1/device/images/${image.id}`,
      headers: { cookie: owner },
    });
    expectError(withCookie, 401, "unauthorized");

    // A revoked screen gets 401.
    const revokedScreen = await pairScreen(dashboard.id);
    expect((await deviceGet(revokedScreen.token, image.id)).statusCode).toBe(
      200,
    );
    const revoked = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/devices/${revokedScreen.deviceId}/revoke`,
      headers: { cookie: owner },
    });
    expect(revoked.statusCode).toBe(200);
    expectError(
      await deviceGet(revokedScreen.token, image.id),
      401,
      "unauthorized",
    );
  });
});

describe("logs", () => {
  it("never contain image bytes or names", () => {
    const text = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const name of [
      "plain.png",
      "holiday.jpg",
      "Private Name",
      "first.png",
    ]) {
      expect(text).not.toContain(name);
    }
    expect(text).not.toContain("IHDR");
    expect(text).not.toContain("JFIF");
    expect(text).not.toContain(
      fixture("plain.png").toString("base64").slice(0, 24),
    );
  });
});
