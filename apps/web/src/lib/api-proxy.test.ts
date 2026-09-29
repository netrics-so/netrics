import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  clientIp,
  MAX_PROXY_BODY_BYTES,
  proxyRequestHeaders,
  proxyResponseHeaders,
  proxyToApi,
} from "./api-proxy";

describe("api proxy headers", () => {
  it("forwards end-to-end request headers and drops hop-by-hop ones", () => {
    const headers = proxyRequestHeaders(
      new Headers({
        cookie: "better-auth.session_token=abc",
        origin: "https://netrics.example.com",
        "content-type": "application/json",
        connection: "keep-alive",
        host: "netrics.example.com",
        "transfer-encoding": "chunked",
        "content-length": "12",
      }),
    );
    expect(Object.fromEntries(headers)).toEqual({
      cookie: "better-auth.session_token=abc",
      origin: "https://netrics.example.com",
      "content-type": "application/json",
    });
  });

  it("keeps every Set-Cookie and drops encodings fetch already undid", () => {
    const upstream = new Headers({
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": "99",
    });
    upstream.append("set-cookie", "a=1; Path=/; HttpOnly");
    upstream.append("set-cookie", "b=2; Path=/; Secure");
    const headers = proxyResponseHeaders(upstream);
    expect(headers.getSetCookie()).toEqual([
      "a=1; Path=/; HttpOnly",
      "b=2; Path=/; Secure",
    ]);
    expect(headers.get("content-encoding")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("forwards only the client address the trusted proxy saw", () => {
    // The client sent a forged chain; the proxy in front of the web server
    // appended the address it really received the request from.
    const headers = proxyRequestHeaders(
      new Headers({
        "x-forwarded-for": "203.0.113.66, 10.0.0.9, 198.51.100.7",
        "x-real-ip": "203.0.113.66",
        forwarded: "for=203.0.113.66",
      }),
      1,
    );
    expect(headers.get("x-forwarded-for")).toBe("198.51.100.7");
    expect(headers.get("x-real-ip")).toBe("198.51.100.7");
    expect(headers.get("forwarded")).toBeNull();
  });

  it("walks back one entry per configured proxy hop", () => {
    const incoming = new Headers({
      "x-forwarded-for": "203.0.113.66, 198.51.100.7, 192.0.2.10",
    });
    expect(clientIp(incoming, 1)).toBe("192.0.2.10");
    expect(clientIp(incoming, 2)).toBe("198.51.100.7");
    // More hops than entries: the leftmost address is all there is.
    expect(clientIp(incoming, 5)).toBe("203.0.113.66");
  });

  it("sends no forwarding headers when there is no address", () => {
    const headers = proxyRequestHeaders(
      new Headers({ "x-real-ip": "1.2.3.4" }),
    );
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("x-real-ip")).toBeNull();
  });

  it("can take the client address from a header the edge sets", () => {
    const incoming = new Headers({
      "x-forwarded-for": "203.0.113.66, 100.64.0.3, 100.64.0.4",
      "x-real-ip": "198.51.100.7",
    });
    expect(clientIp(incoming, 1, "x-real-ip")).toBe("198.51.100.7");
    const headers = proxyRequestHeaders(incoming, 1, "x-real-ip");
    expect(headers.get("x-forwarded-for")).toBe("198.51.100.7");
  });
});

describe("api proxy requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("passes device credentials and ETags through, and 304 back (#59)", async () => {
    vi.stubEnv("NETRICS_API_URL", "http://api.internal:3001");
    const upstream = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, {
          status: 304,
          headers: { etag: '"v1"', "cache-control": "no-cache" },
        }),
    );
    vi.stubGlobal("fetch", upstream);

    const response = await proxyToApi(
      new Request("https://netrics.example.com/v1/device/dashboard", {
        headers: {
          authorization: "Bearer device-token",
          "if-none-match": '"v1"',
        },
      }),
    );

    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe("http://api.internal:3001/v1/device/dashboard");
    const sent = new Headers(init!.headers);
    expect(sent.get("authorization")).toBe("Bearer device-token");
    expect(sent.get("if-none-match")).toBe('"v1"');
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get("etag")).toBe('"v1"');
  });

  it("answers 502 when the API cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const response = await proxyToApi(
      new Request("https://netrics.example.com/v1/device/dashboard"),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "api_unreachable" });
  });
});

// A real HTTP upstream and the real global fetch: Node's fetch treats a 401
// specially, which a stubbed fetch cannot show (#118).
describe("api proxy against a real upstream", () => {
  let server: Server;
  let received: { method: string; url: string; body: Buffer }[] = [];

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      void readBody(req).then((body) => {
        received.push({ method: req.method!, url: req.url!, body });
        if (req.url === "/v1/device/token") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        res.writeHead(200, {
          "content-type": req.headers["content-type"] ?? "",
        });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    received = [];
    vi.unstubAllEnvs();
  });

  function useUpstream() {
    const { port } = server.address() as AddressInfo;
    vi.stubEnv("NETRICS_API_URL", `http://127.0.0.1:${port}`);
  }

  it("passes a 401 answer to a POST with a body through (#118)", async () => {
    useUpstream();
    const response = await proxyToApi(
      new Request("https://netrics.example.com/v1/device/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: "x" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(received).toHaveLength(1);
    expect(received[0]!.body.toString()).toBe('{"refreshToken":"x"}');
  });

  it("forwards a POST body byte for byte", async () => {
    useUpstream();
    const payload = new Uint8Array(70_000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) % 256;
    const response = await proxyToApi(
      new Request("https://netrics.example.com/v1/echo?x=1", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: payload,
      }),
    );
    expect(response.status).toBe(200);
    expect(received[0]!.method).toBe("POST");
    expect(received[0]!.url).toBe("/v1/echo?x=1");
    expect(Buffer.compare(received[0]!.body, Buffer.from(payload))).toBe(0);
    const echoed = new Uint8Array(await response.arrayBuffer());
    expect(Buffer.compare(Buffer.from(echoed), Buffer.from(payload))).toBe(0);
  });

  // A body source that counts what the proxy pulls from it and whether the
  // proxy cancelled it, delivering `total` bytes in 64 KiB chunks.
  function countedStream(total: number) {
    const state = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const size = Math.min(65_536, total - state.pulled);
        if (size <= 0) {
          controller.close();
          return;
        }
        state.pulled += size;
        controller.enqueue(new Uint8Array(size).fill(7));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { stream, state };
  }

  function streamedPost(body: ReadableStream<Uint8Array>, headers = {}) {
    return new Request("https://netrics.example.com/v1/echo", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...headers },
      body,
      duplex: "half",
    } as RequestInit);
  }

  it("answers 413 to a declared oversize body without reading it", async () => {
    useUpstream();
    const { stream, state } = countedStream(4 * MAX_PROXY_BODY_BYTES);
    const response = await proxyToApi(
      streamedPost(stream, {
        "content-length": String(MAX_PROXY_BODY_BYTES + 1),
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
    expect(received).toHaveLength(0);
    // Only what the stream buffers ahead on its own, never the body.
    expect(state.pulled).toBeLessThanOrEqual(65_536);
  });

  it("answers 413 once an undeclared body passes the limit", async () => {
    useUpstream();
    const { stream, state } = countedStream(4 * MAX_PROXY_BODY_BYTES);
    const response = await proxyToApi(streamedPost(stream));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
    expect(received).toHaveLength(0);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(2 * MAX_PROXY_BODY_BYTES);
  });

  it("forwards a body of exactly the limit", async () => {
    useUpstream();
    const { stream } = countedStream(MAX_PROXY_BODY_BYTES);
    const response = await proxyToApi(streamedPost(stream));
    expect(response.status).toBe(200);
    expect(received[0]!.body.length).toBe(MAX_PROXY_BODY_BYTES);
    expect((await response.arrayBuffer()).byteLength).toBe(
      MAX_PROXY_BODY_BYTES,
    );
  });

  it("sends GET without a body", async () => {
    useUpstream();
    const response = await proxyToApi(
      new Request("https://netrics.example.com/v1/echo"),
    );
    expect(response.status).toBe(200);
    expect(received[0]!.method).toBe("GET");
    expect(received[0]!.body.length).toBe(0);
  });
});
