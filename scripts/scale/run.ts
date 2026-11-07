// Repeats the opt-in scale measurements of #501 and summarizes their spread.
// Each run is a fresh Vitest process on its own disposable database (the
// test harness creates and drops it), so runs do not share caches or peaks.
//
//   node scripts/scale/run.ts history     [--runs 3] [--out file.jsonl]
//   node scripts/scale/run.ts concurrency [--runs 3] [--out file.jsonl]
//   node scripts/scale/run.ts play        [--runs 3] [--out file.jsonl]
//
// NETRICS_TEST_ADMIN_URL selects the PostgreSQL server (default: the local
// test server on 5433). Size variables (NETRICS_SCALE_*) pass through; see
// docs/data-scale-validation.md for the recorded sizes.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const SUITES: Record<
  string,
  { file: string; marker: string; variants: Array<Record<string, string>> }
> = {
  history: {
    file: "apps/server/src/data/retained-history-scale.test.ts",
    marker: "NETRICS_SCALE_HISTORY_RESULT ",
    variants: [{ NETRICS_SCALE_HISTORY: "1" }],
  },
  concurrency: {
    file: "apps/server/src/data/concurrent-ingestion-scale.test.ts",
    marker: "NETRICS_SCALE_CONCURRENCY_RESULT ",
    variants: [{ NETRICS_SCALE_CONCURRENCY: "1" }],
  },
  play: {
    file: "apps/server/src/sync/play-memory-scale.test.ts",
    marker: "NETRICS_SCALE_PLAY_RESULT ",
    variants: (process.env.NETRICS_SCALE_PLAY_SIZES ?? "8,16,32,63")
      .split(",")
      .flatMap((mib) =>
        ["all", "selected"].map((scope) => ({
          NETRICS_SCALE_PLAY_MIB: mib,
          NETRICS_SCALE_PLAY_SCOPE: scope,
        })),
      ),
  },
};

const [suiteName, ...rest] = process.argv.slice(2);
const suite = suiteName ? SUITES[suiteName] : undefined;
if (!suite) {
  console.error(
    "usage: run.ts <history|concurrency|play> [--runs N] [--out file]",
  );
  process.exit(2);
}
const option = (name: string, fallback?: string) => {
  const index = rest.indexOf("--" + name);
  return index >= 0 ? rest[index + 1] : fallback;
};
const runs = Number(option("runs", "3"));
const out = option("out", undefined);

/** Numeric leaves as dotted paths; arrays of objects keep their index. */
function leaves(
  value: unknown,
  path = "",
  into = new Map<string, number>(),
): Map<string, number> {
  if (typeof value === "number") into.set(path, value);
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value))
      leaves(child, path ? path + "." + key : key, into);
  return into;
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

let failed = false;
for (const variant of suite.variants) {
  const label = Object.values(variant).join(" ");
  const results: Array<Record<string, unknown>> = [];
  for (let run = 1; run <= runs; run++) {
    const started = Date.now();
    const child = spawnSync(
      "pnpm",
      ["exec", "vitest", "run", suite.file, "--silent=false"],
      {
        env: {
          NETRICS_TEST_ADMIN_URL:
            "postgres://netrics:netrics@localhost:5433/postgres",
          ...process.env,
          ...variant,
        },
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    const line = child.stdout
      .split("\n")
      .find((entry) => entry.startsWith(suite.marker));
    if (child.status !== 0 || !line) {
      failed = true;
      console.error(`[${label}] run ${run} failed (exit ${child.status})`);
      console.error(child.stdout.slice(-4000), child.stderr.slice(-4000));
      continue;
    }
    const result = JSON.parse(line.slice(suite.marker.length));
    results.push(result);
    if (out)
      appendFileSync(
        out,
        JSON.stringify({ suite: suiteName, variant, run, result }) + "\n",
      );
    console.error(
      `[${label}] run ${run}/${runs} done in ${Math.round((Date.now() - started) / 1000)} s`,
    );
  }
  if (results.length === 0) continue;
  const series = new Map<string, number[]>();
  for (const result of results)
    for (const [path, value] of leaves(result))
      if (!path.startsWith("environment.") && !path.startsWith("sizes."))
        series.set(path, [...(series.get(path) ?? []), value]);
  console.log(`\n## ${suiteName} ${label} (${results.length} runs)`);
  const [first] = results as [Record<string, unknown>];
  console.log(JSON.stringify(first.environment));
  if (first.sizes) console.log(JSON.stringify(first.sizes));
  for (const [path, values] of series) {
    const low = Math.min(...values),
      high = Math.max(...values);
    console.log(
      `${path}: ${median(values)}` + (low === high ? "" : ` [${low}–${high}]`),
    );
  }
}
process.exit(failed ? 1 : 0);
