// The test request of the custom API builder (milestone 13, #806): runs one
// stream of the unsaved definition against the draft's stored secrets and
// answers a bounded, value-redacted response tree, the record arrays, type
// suggestions, the mapped preview rows and a request log. Nothing from the
// run is stored except the draft's updated_at; no secret reaches the
// answer, the log or the error text.

import {
  customApiTestRequestSchema,
  type CustomApiDraftDefinition,
  type CustomApiTestRequest,
  type CustomApiTestResponse,
} from "@netrics/contracts";
import {
  createEgressFetch,
  EgressDeniedError,
  EgressTimeoutError,
  type ExecuteOptions,
} from "@netrics/connector-runtime";
import {
  CUSTOM_API_MESSAGES,
  CustomApiAuthError,
  CustomApiConfigError,
  CustomApiHttpError,
  CustomApiResponseError,
  customApiCredentialHosts,
  customApiEnvironmentHost,
  customApiSecretValues,
  findRecordArrays,
  readPath,
  runCustomApiTestStream,
  shortPath,
  streamChunks,
  suggestFields,
  type Chunk,
  type CustomApiCredentials,
  type CustomApiPageTrace,
  type CustomApiTestStop,
} from "@netrics/connectors/custom-api";
import { withWorkspace, type Database } from "@netrics/database";

import {
  createCustomApiDraftService,
  customApiCredentialNames,
  draftBinding,
  draftBindingHolds,
  isCustomApiOAuth,
  type CustomApiDraftDeps,
  type DraftActor,
  type DraftResult,
} from "./drafts.js";
import { customApiEgress } from "./connectors.js";
import {
  boundedPreview,
  CUSTOM_API_TEST_LIMITS,
  redactText,
  redactUrl,
  secretSetOf,
  type JsonValue,
  type SecretSet,
} from "./preview.js";
import { takeCustomApiTestSlot } from "./test-rate.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type TestRequestResult =
  | DraftResult<CustomApiTestResponse>
  | { ok: false; status: 429; error: string; retryAfterSeconds: number };

export interface CustomApiTestRequestDeps extends CustomApiDraftDeps {
  db: Database;
  /** Self-host only (NETRICS_CUSTOM_API_PRIVATE_HOSTS). */
  privateHosts: readonly string[];
  /** Tests only: egress options (tlsCa, allowPrivateHosts, …). */
  executeOptions?: ExecuteOptions;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value === "object" ? "object" : typeof value;
}

/** Whether an error, or one it wraps, is of a class (egress errors may arrive as a fetch cause). */
function caused<T extends Error>(
  error: unknown,
  type: abstract new (...args: never[]) => T,
): boolean {
  let current: unknown = error;
  for (let i = 0; i < 5 && current; i++) {
    if (
      current instanceof type ||
      (current instanceof Error && current.name === type.name)
    )
      return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function errorOf(
  error: unknown,
  firstBody: unknown,
  records: string,
): { code: string; message: string } {
  if (error instanceof CustomApiAuthError)
    return { code: "custom_api_auth_rejected", message: error.message };
  if (error instanceof CustomApiHttpError)
    return { code: "custom_api_http_error", message: error.message };
  if (
    error instanceof CustomApiResponseError &&
    error.message === CUSTOM_API_MESSAGES.recordsNotList
  ) {
    const found = readPath(firstBody, records);
    const type = found.found ? jsonType(found.value) : "nothing";
    return {
      code: "custom_api_records_not_array",
      message: `The record path points to a ${type}, not a list. Pick the list that holds the records.`,
    };
  }
  if (error instanceof CustomApiResponseError)
    return { code: "custom_api_response_invalid", message: error.message };
  if (error instanceof CustomApiConfigError)
    return { code: "custom_api_request_invalid", message: error.message };
  if (caused(error, EgressTimeoutError))
    return {
      code: "custom_api_timeout",
      message: "The API did not answer in time.",
    };
  if (caused(error, EgressDeniedError))
    return {
      code: "custom_api_destination_blocked",
      message:
        "netrics may not reach this address. Custom APIs must be public https hosts.",
    };
  return {
    code: "custom_api_test_failed",
    message:
      error instanceof Error ? error.message : "The test request failed.",
  };
}

/**
 * The chunk the test reads: the request's window, else for a windowed
 * stream the last stepDays ending today in the definition's zone, else none.
 */
export function testChunk(
  definition: CustomApiDraftDefinition,
  window: { start: string; end: string } | undefined,
  now: Date,
): Chunk | null {
  if (window) return { from: window.start, to: window.end };
  const streamWindow = definition.stream.window;
  if (streamWindow.type === "none") return null;
  const chunks = streamChunks(
    definition.stream,
    {
      mode: "incremental",
      from: new Date(
        now.getTime() - (streamWindow.stepDays - 1) * DAY_MS,
      ).toISOString(),
      to: now.toISOString(),
    },
    definition.defaults.timeZone,
  );
  return chunks.at(-1) ?? null;
}

/**
 * The mapped preview rows: at most 100, bounded together to
 * CUSTOM_API_TEST_LIMITS.rowsBytes (each row gets what is left of it).
 */
function previewRows(
  rows: readonly Record<string, unknown>[],
  secrets: SecretSet,
): { rows: Record<string, JsonValue>[]; truncated: boolean } {
  const out: Record<string, JsonValue>[] = [];
  let left: number = CUSTOM_API_TEST_LIMITS.rowsBytes;
  let truncated = rows.length > CUSTOM_API_TEST_LIMITS.rows;
  for (const row of rows.slice(0, CUSTOM_API_TEST_LIMITS.rows)) {
    if (left < 8_192) {
      truncated = true;
      break;
    }
    const bounded = boundedPreview(
      row,
      secrets,
      Math.min(left, CUSTOM_API_TEST_LIMITS.previewBytes),
    );
    if (bounded.truncated) truncated = true;
    if (
      typeof bounded.body !== "object" ||
      bounded.body === null ||
      Array.isArray(bounded.body)
    ) {
      truncated = true;
      break;
    }
    left -= Buffer.byteLength(JSON.stringify(bounded.body), "utf8") + 1;
    out.push(bounded.body);
  }
  return { rows: out, truncated };
}

/**
 * The whole answer stays within CUSTOM_API_TEST_LIMITS.responseBytes: the
 * parts are bounded on their own already (tree 256 KiB, rows 512 KiB,
 * 100 suggestions with 3 samples of 80 characters, 5 log lines); should
 * they still add up to more, rows, then samples, then the tree, then the
 * suggestions and record arrays go.
 */
function capResponse(response: CustomApiTestResponse): CustomApiTestResponse {
  const size = () => Buffer.byteLength(JSON.stringify(response), "utf8");
  const limit = CUSTOM_API_TEST_LIMITS.responseBytes;
  if (size() <= limit) return response;
  response = { ...response, truncated: true, rows: [] };
  if (size() <= limit) return response;
  response = {
    ...response,
    suggestions: response.suggestions.map((s) => ({ ...s, samples: [] })),
  };
  if (size() <= limit) return response;
  if (response.response)
    response = {
      ...response,
      response: {
        ...response.response,
        body: "… (response too large to show)",
        truncated: true,
      },
    };
  if (size() <= limit) return response;
  // Paths are cut to 500 characters, so this is a last guard only.
  return { ...response, suggestions: [], recordArrays: [] };
}

export function createCustomApiTestRequestService(
  deps: CustomApiTestRequestDeps,
) {
  const drafts = createCustomApiDraftService(deps);
  const now = deps.now ?? (() => new Date());
  /** One running test per draft (per API process). */
  const running = new Set<string>();

  return {
    async run(
      actor: DraftActor,
      draftId: string,
      raw: CustomApiTestRequest,
      log?: (fields: Record<string, unknown>) => void,
    ): Promise<TestRequestResult> {
      // The rate limit comes first: no other work, no network.
      const slot = await withWorkspace(
        deps.db,
        { workspaceId: actor.workspaceId, userId: actor.callerId },
        (tx) => takeCustomApiTestSlot(tx, actor.workspaceId, now()),
      );
      if (!slot.ok)
        return {
          ok: false,
          status: 429,
          error: "custom_api_test_rate_limited",
          retryAfterSeconds: slot.retryAfterSeconds,
        };
      const body = customApiTestRequestSchema.parse(raw);
      const definition = body.definition;

      const before = await drafts.open(actor, draftId);
      if (!before.ok) return before;
      if (!definition.environments.some((e) => e.id === body.environmentId))
        return {
          ok: false,
          status: 400,
          error: "custom_api_environment_not_found",
        };
      const hostChanged = !draftBindingHolds(
        before.value.state,
        draftBinding(definition, body.environmentId),
      );
      // Stored through the draft rule: secrets for other hosts are deleted.
      const stored = await drafts.update(actor, draftId, {
        definition,
        environmentId: body.environmentId,
        variables: body.variables,
      });
      if (!stored.ok) return stored;
      const draft = stored.value;
      if (hostChanged)
        return {
          ok: false,
          status: 409,
          error: "custom_api_credentials_host_changed",
        };

      const empty = (
        code: string,
        message: string,
      ): DraftResult<CustomApiTestResponse> => ({
        ok: true,
        value: {
          truncated: false,
          ok: false,
          error: { code, message },
          response: null,
          recordArrays: [],
          records: { path: definition.stream.records, count: 0, found: false },
          suggestions: [],
          rows: [],
          mapping: { skipped: 0, nulled: {} },
          log: [],
          stopped: "error",
          window: null,
          draft,
        },
      });
      if (isCustomApiOAuth(definition.auth))
        return empty(
          "custom_api_oauth_unavailable",
          "OAuth login for custom APIs is not available yet.",
        );
      const required = [
        ...customApiCredentialNames(definition.auth),
        ...definition.variables.filter((v) => v.secret).map((v) => v.id),
      ];
      if (required.some((name) => !draft.secretsSet.includes(name)))
        return empty(
          "custom_api_secret_missing",
          "Enter the login details this API needs before testing.",
        );
      if (running.has(draftId))
        return { ok: false, status: 409, error: "custom_api_test_busy" };

      running.add(draftId);
      try {
        const opened = await drafts.open(actor, draftId);
        if (!opened.ok) return opened;
        const environment = definition.environments.find(
          (e) => e.id === body.environmentId,
        )!;
        const envelope = opened.value.credentials ?? {};
        const credentials = {
          host: customApiEnvironmentHost(environment),
          ...envelope,
        } as CustomApiCredentials;
        const secretVariables =
          envelope.variables && typeof envelope.variables === "object"
            ? (envelope.variables as Record<string, string>)
            : {};
        const secrets: SecretSet = secretSetOf(envelope, secretVariables, [
          ...customApiSecretValues(definition, credentials, body.variables),
        ]);
        const chunk = testChunk(definition, body.window, now());
        const controller = new AbortController();
        const egress = customApiEgress(
          deps.privateHosts,
          deps.executeOptions?.egress,
        );
        const fetch = createEgressFetch({
          ...egress,
          allowedDomains: customApiCredentialHosts(
            definition,
            body.environmentId,
          ),
          signal: controller.signal,
        });
        const traces: CustomApiPageTrace[] = [];
        let result:
          Awaited<ReturnType<typeof runCustomApiTestStream>> | undefined;
        let failure: { code: string; message: string } | null = null;
        const timer = setTimeout(
          () => controller.abort(),
          CUSTOM_API_TEST_LIMITS.totalMs,
        );
        try {
          result = await runCustomApiTestStream({
            definition,
            stream: definition.stream,
            environmentId: body.environmentId,
            config: body.variables,
            credentials,
            fetch,
            chunk,
            limits: {
              maxPages: body.pages,
              maxRecords: CUSTOM_API_TEST_LIMITS.maxRecords,
              deadline: Date.now() + CUSTOM_API_TEST_LIMITS.totalMs,
            },
            onPage: (trace) => traces.push(trace),
          });
        } catch (error) {
          failure = errorOf(
            controller.signal.aborted
              ? new EgressTimeoutError("api", 0)
              : error,
            traces[0]?.body,
            definition.stream.records,
          );
        } finally {
          clearTimeout(timer);
          controller.abort();
        }

        const first = traces[0];
        const firstBody = first?.body ?? null;
        const recordsAt =
          first && first.status !== null
            ? readPath(firstBody, definition.stream.records)
            : ({ found: false } as const);
        const records = !recordsAt.found
          ? []
          : Array.isArray(recordsAt.value)
            ? recordsAt.value
            : recordsAt.value !== null && typeof recordsAt.value === "object"
              ? [recordsAt.value]
              : [];
        const preview = first ? boundedPreview(firstBody, secrets) : null;
        const rows = previewRows(result?.rows ?? [], secrets);
        const stopped: CustomApiTestStop | "error" = failure
          ? "error"
          : result!.stopped;
        log?.({
          draftId,
          pages: traces.length,
          status: first?.status ?? null,
          stopped,
        });
        return {
          ok: true,
          value: capResponse({
            truncated: rows.truncated || (preview?.truncated ?? false),
            ok: failure === null,
            error: failure
              ? {
                  code: failure.code,
                  message: redactText(failure.message, secrets),
                }
              : null,
            response:
              first && first.status !== null && preview
                ? {
                    status: first.status,
                    contentType: first.contentType
                      ? redactText(first.contentType, secrets)
                      : null,
                    body: preview.body,
                    truncated: preview.truncated,
                    bytes: first.bytes,
                  }
                : null,
            recordArrays: first
              ? findRecordArrays(firstBody).map(({ path, length }) => ({
                  path: shortPath(redactText(path, secrets)),
                  length,
                }))
              : [],
            records: {
              path: definition.stream.records,
              count: records.length,
              found: recordsAt.found,
            },
            suggestions: suggestFields(
              records,
              CUSTOM_API_TEST_LIMITS.rows,
              (text) => redactText(text, secrets),
            ),
            rows: rows.rows,
            mapping: {
              skipped: result?.skipped ?? 0,
              nulled: result?.nulled ?? {},
            },
            log: traces.map((trace) => ({
              page: trace.page,
              method: trace.method,
              url: redactUrl(trace.url, secrets),
              status: trace.status,
              durationMs: trace.durationMs,
              bytes: trace.bytes,
              records: trace.records,
            })),
            stopped,
            window: chunk ? { start: chunk.from, end: chunk.to } : null,
            draft,
          }),
        };
      } finally {
        running.delete(draftId);
      }
    },
  };
}
