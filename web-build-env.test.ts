import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Next.js inlines every NEXT_PUBLIC_* value it finds in code into the build,
// so each one is a build input. The web build gets exactly two, the build
// identity (ADR 0013); configuration is read at request time. The CI web
// build guard (apps/web/scripts/build-env-check.ts) checks the NETRICS_*
// side. The scan covers every tracked file: code, Dockerfiles, workflows,
// env examples and docs.
const ALLOWED = ["NEXT_PUBLIC_APP_VERSION", "NEXT_PUBLIC_GIT_SHA"];

function nextPublicNames(text: string): string[] {
  return [...text.matchAll(/\bNEXT_PUBLIC_[A-Z0-9_]+/g)].map(([name]) => name);
}

describe("NEXT_PUBLIC_* variables", () => {
  it("finds names in source text", () => {
    const name = "NEXT_PUBLIC_" + "API_URL";
    expect(nextPublicNames(`const url = process.env.${name};`)).toEqual([name]);
  });

  it("are only the build identity", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter(
        (file) => file && !/\.(png|jpe?g|gif|ico|woff2?|ttf)$/.test(file),
      );
    const offenders: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue; // deleted in the working tree, or a submodule
      }
      for (const name of nextPublicNames(text)) {
        if (!ALLOWED.includes(name)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
