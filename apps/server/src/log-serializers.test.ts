import { DrizzleQueryError } from "drizzle-orm/errors";
import pino from "pino";
import { describe, expect, it } from "vitest";

import { errorSerializer, logSerializers } from "./log-serializers.js";

// Bound query values never reach a log line (#217 review, M1).

function driverError(): Error {
  const cause = Object.assign(
    new Error('new row violates check constraint "x"'),
    {
      code: "23514",
      parameters: ["Private Name.png", "\\x89504e47secret"],
    },
  );
  return new DrizzleQueryError(
    'insert into "workspace_images" ("name", "content") values ($1, $2)',
    ["Private Name.png", Buffer.from("\x89PNG secret bytes")],
    cause,
  );
}

describe("log serializers", () => {
  it("drop drizzle params and postgres parameters, keep the SQL", () => {
    const error = driverError();
    // drizzle-orm repeats the values in the message and the stack.
    expect(error.message).toContain("Private Name.png");
    const text = JSON.stringify(errorSerializer(error));
    expect(text).not.toContain("Private Name");
    expect(text).not.toContain("secret");
    expect(text).toContain('insert into \\"workspace_images\\"');
  });

  it("apply to a pino logger's err field", () => {
    const lines: string[] = [];
    const logger = pino(
      { serializers: logSerializers },
      { write: (line: string) => lines.push(line) },
    );
    logger.error({ err: driverError() }, "unhandled error");
    expect(lines.join("")).not.toContain("Private Name");
    expect(lines.join("")).not.toContain("secret");
    expect(lines.join("")).toContain("Failed query");
  });
});
