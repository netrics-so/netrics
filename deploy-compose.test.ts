import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Self-hosting (deploy/compose): a custom API on the owner's own network may
// use a certificate from a private CA. The api and the worker both reach
// custom APIs, so both must be able to trust it (#835).
const compose = readFileSync("deploy/compose/compose.yml", "utf8");

/** The lines of one service block in compose.yml. */
function service(name: string): string {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `service ${name}`).toBeGreaterThan(-1);
  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}\S/.test(line),
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("deploy/compose private certificate authorities", () => {
  for (const name of ["api", "worker"]) {
    it(`passes NODE_EXTRA_CA_CERTS to the ${name} and mounts ./certs`, () => {
      const block = service(name);
      expect(block).toContain("NODE_EXTRA_CA_CERTS: ${NODE_EXTRA_CA_CERTS:-}");
      expect(block).toContain("- ./certs:/etc/netrics/certs:ro");
    });
  }

  it("is documented in the self-hosting README", () => {
    const readme = readFileSync("deploy/compose/README.md", "utf8");
    expect(readme).toContain(
      "NODE_EXTRA_CA_CERTS=/etc/netrics/certs/internal-ca.pem",
    );
  });
});
