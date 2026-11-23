"use client";

import { useState } from "react";

import type {
  CustomApiDraftDefinition,
  CustomApiPagination,
} from "@netrics/contracts";

import type { ReadOnlyRequest } from "@/lib/custom-api-builder";
import { useT } from "@/lib/i18n/client";

type Request = CustomApiDraftDefinition["stream"]["request"];

/**
 * The exact request a read-only confirmation is about (ADR 0030 §2): the
 * method and the address at each base URL, the query parameters and
 * header templates, the page values written into the body, and the body
 * template. Templates only: never a value or a secret.
 */
export function RequestPreview({
  request,
  baseUrls,
  pagination,
}: {
  request: Request;
  baseUrls: readonly string[];
  pagination?: CustomApiPagination;
}) {
  const t = useT("customApi.test.readOnly");
  const method: string = request.method ?? "GET";
  const body = request.body?.kind === "json" ? request.body.value : null;
  const query = Object.entries(request.query ?? {});
  const headers = Object.entries(request.headers ?? {});
  const bodyPaths: [string, string][] = [];
  if (pagination?.type === "cursor" && pagination.bodyPath)
    bodyPaths.push([t("pageCursor"), pagination.bodyPath]);
  if (pagination?.type === "offset") {
    if (pagination.offsetBodyPath)
      bodyPaths.push([t("pageOffset"), pagination.offsetBodyPath]);
    if (pagination.limitBodyPath)
      bodyPaths.push([t("pageLimit"), pagination.limitBodyPath]);
  }
  return (
    <div className="stack custom-api-request-preview">
      {(baseUrls.length ? baseUrls : [""]).map((baseUrl) => (
        <p key={baseUrl}>
          <code>
            {method} {baseUrl}
            {request.path}
          </code>
        </p>
      ))}
      {query.length ? (
        <dl>
          <dt>{t("query")}</dt>
          {query.map(([name, value]) => (
            <dd key={name}>
              <code>
                {name}={value}
              </code>
            </dd>
          ))}
        </dl>
      ) : null}
      {headers.length ? (
        <dl>
          <dt>{t("headers")}</dt>
          {headers.map(([name, value]) => (
            <dd key={name}>
              <code>
                {name}: {value}
              </code>
            </dd>
          ))}
        </dl>
      ) : null}
      {bodyPaths.length ? (
        <dl>
          <dt>{t("pageValues")}</dt>
          {bodyPaths.map(([label, path]) => (
            <dd key={label}>
              {label}: <code>{path}</code>
            </dd>
          ))}
        </dl>
      ) : null}
      <pre>
        <code>{JSON.stringify(body, null, 2)}</code>
      </pre>
    </div>
  );
}

/**
 * The server's read-only challenge for a JSON-body POST test (ADR 0030 §2):
 * the exact request, and a confirmation that it only reads data.
 * Confirming resends the test with the server's hash of exactly this
 * request; the builder drops the challenge as soon as the request changes.
 */
export function ReadOnlyConfirm({
  request,
  baseUrl,
  pagination,
  pending,
  onConfirm,
  onCancel,
}: {
  request: Request;
  /** The test environment's base URL. */
  baseUrl?: string;
  pagination?: CustomApiPagination;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT("customApi.test.readOnly");
  const [checked, setChecked] = useState(false);
  return (
    <div
      className="notice warning stack"
      role="alertdialog"
      aria-labelledby="custom-api-read-only-title"
      aria-describedby="custom-api-read-only-help"
      data-testid="custom-api-read-only"
    >
      <strong id="custom-api-read-only-title">{t("title")}</strong>
      <p id="custom-api-read-only-help">{t("help")}</p>
      <RequestPreview
        request={request}
        baseUrls={baseUrl ? [baseUrl] : []}
        {...(pagination ? { pagination } : {})}
      />
      <label className="checkbox">
        <input
          id="custom-api-read-only-confirm"
          type="checkbox"
          checked={checked}
          disabled={pending}
          onChange={(event) => setChecked(event.target.checked)}
        />{" "}
        {t("confirm")}
      </label>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!checked || pending}
          onClick={onConfirm}
        >
          {t("send")}
        </button>
        <button type="button" disabled={pending} onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}

/**
 * The save-time confirmation (ADR 0030 §2): every JSON-body POST stream of
 * the version being saved, with the exact request it saves and "this
 * request only reads data". The version carries the confirmation only
 * for a request confirmed as it is; any change to it asks again.
 */
export function ReadOnlySave({
  requests,
  baseUrls,
  onConfirm,
}: {
  requests: readonly ReadOnlyRequest[];
  baseUrls: readonly string[];
  onConfirm: (streamKey: string, confirmed: boolean) => void;
}) {
  const t = useT("customApi.review.readOnly");
  if (requests.length === 0) return null;
  return (
    <section
      className="notice warning stack"
      aria-labelledby="custom-api-read-only-save-title"
      data-testid="custom-api-read-only-save"
    >
      <h3 id="custom-api-read-only-save-title">{t("title")}</h3>
      <p>{t("help")}</p>
      {requests.map(({ stream, confirmed }) => {
        const id = `custom-api-read-only-save-${stream.key}`;
        return (
          <div
            key={stream.key}
            className="stack"
            data-testid={`custom-api-read-only-save-${stream.key}`}
          >
            <h4>{stream.name}</h4>
            <RequestPreview
              request={stream.request}
              baseUrls={baseUrls}
              pagination={stream.pagination}
            />
            <label className="checkbox" htmlFor={id}>
              <input
                id={id}
                type="checkbox"
                checked={confirmed}
                onChange={(event) =>
                  onConfirm(stream.key, event.target.checked)
                }
              />{" "}
              {t("confirm", { name: stream.name })}
            </label>
          </div>
        );
      })}
    </section>
  );
}
