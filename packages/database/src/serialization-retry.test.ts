import { describe, expect, it } from "vitest";

import {
  isSerializationFailure,
  retryOnSerializationFailure,
  SERIALIZATION_RETRY_DEFAULTS,
} from "./serialization-retry.js";

const pgError = (code: string) =>
  Object.assign(new Error("database error " + code), { code });
/** A drizzle-style wrapper: the driver error is the cause. */
const wrapped = (code: string) =>
  new Error("Failed query", { cause: pgError(code) });

function harness(random = () => 1) {
  const waits: number[] = [];
  let clock = 0;
  return {
    waits,
    options: {
      random,
      now: () => clock,
      sleep: async (ms: number) => {
        waits.push(ms);
        clock += ms;
      },
    },
  };
}

describe("retryOnSerializationFailure (#598)", () => {
  it("recognises serialization failures and deadlocks through causes", () => {
    expect(isSerializationFailure(wrapped("40001"))).toBe(true);
    expect(isSerializationFailure(wrapped("40P01"))).toBe(true);
    expect(isSerializationFailure(wrapped("23505"))).toBe(false);
    expect(isSerializationFailure("40001")).toBe(false);
  });

  it("retries until the attempt succeeds", async () => {
    const { options, waits } = harness();
    let calls = 0;
    const result = await retryOnSerializationFailure(async (index) => {
      expect(index).toBe(calls);
      calls++;
      if (calls < 6) throw wrapped(calls % 2 ? "40001" : "40P01");
      return "done";
    }, options);
    expect(result).toBe("done");
    expect(calls).toBe(6);
    // Full jitter at its upper bound: 10 ms doubling.
    expect(waits).toEqual([10, 20, 40, 80, 160]);
  });

  it("caps each wait and draws it at random below the cap", async () => {
    const { options, waits } = harness(() => 0.5);
    let calls = 0;
    await expect(
      retryOnSerializationFailure(
        async () => {
          calls++;
          throw wrapped("40001");
        },
        { ...options, budgetMs: 60_000 },
      ),
    ).rejects.toMatchObject({ cause: { code: "40001" } });
    expect(calls).toBe(SERIALIZATION_RETRY_DEFAULTS.attempts);
    expect(waits).toHaveLength(SERIALIZATION_RETRY_DEFAULTS.attempts - 1);
    expect(Math.max(...waits)).toBe(
      SERIALIZATION_RETRY_DEFAULTS.maxDelayMs / 2,
    );
    expect(waits.slice(0, 3)).toEqual([5, 10, 20]);
  });

  it("rethrows the last error when attempts run out", async () => {
    const { options } = harness();
    const errors = [wrapped("40001"), wrapped("40001"), wrapped("40P01")];
    let calls = 0;
    await expect(
      retryOnSerializationFailure(
        async () => {
          throw errors[calls++];
        },
        { ...options, attempts: 3 },
      ),
    ).rejects.toBe(errors[2]);
    expect(calls).toBe(3);
  });

  it("stops before the time budget is spent", async () => {
    const { options, waits } = harness();
    let calls = 0;
    await expect(
      retryOnSerializationFailure(
        async () => {
          calls++;
          throw wrapped("40001");
        },
        { ...options, attempts: 100, budgetMs: 100 },
      ),
    ).rejects.toMatchObject({ cause: { code: "40001" } });
    // 10 + 20 + 40 = 70 ms; the next wait (80 ms) would pass 100 ms.
    expect(waits).toEqual([10, 20, 40]);
    expect(calls).toBe(4);
  });

  it("does not retry other errors, or a single attempt", async () => {
    const { options, waits } = harness();
    let calls = 0;
    const unique = wrapped("23505");
    await expect(
      retryOnSerializationFailure(async () => {
        calls++;
        throw unique;
      }, options),
    ).rejects.toBe(unique);
    await expect(
      retryOnSerializationFailure(
        async () => {
          calls++;
          throw wrapped("40001");
        },
        { ...options, attempts: 1 },
      ),
    ).rejects.toMatchObject({ cause: { code: "40001" } });
    expect(calls).toBe(2);
    expect(waits).toEqual([]);
  });

  it("asks a custom predicate with the attempt index", async () => {
    const { options } = harness();
    const seen: number[] = [];
    let calls = 0;
    await expect(
      retryOnSerializationFailure(
        async () => {
          calls++;
          throw new Error("version_conflict");
        },
        {
          ...options,
          retryable: (_error, index) => (seen.push(index), index < 2),
        },
      ),
    ).rejects.toThrow("version_conflict");
    expect(seen).toEqual([0, 1, 2]);
    expect(calls).toBe(3);
  });
});
