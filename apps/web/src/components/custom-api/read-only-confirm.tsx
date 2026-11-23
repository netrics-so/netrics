"use client";

import { useState } from "react";

import type { CustomApiDraftDefinition } from "@netrics/contracts";

import { useT } from "@/lib/i18n/client";

/**
 * The server's read-only challenge for a JSON-body POST test (ADR 0030 §2):
 * the exact request (method, path, body template), and a confirmation
 * that it only reads data. Confirming resends the test with the server's
 * hash of exactly this request; any change asks again.
 */
export function ReadOnlyConfirm({
  request,
  pending,
  onConfirm,
  onCancel,
}: {
  request: CustomApiDraftDefinition["stream"]["request"];
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT("customApi.test.readOnly");
  const [checked, setChecked] = useState(false);
  const body = request.body?.kind === "json" ? request.body.value : null;
  const method: string = request.method ?? "GET";
  return (
    <div
      className="notice warning stack"
      role="alertdialog"
      aria-labelledby="custom-api-read-only-title"
      data-testid="custom-api-read-only"
    >
      <strong id="custom-api-read-only-title">{t("title")}</strong>
      <p>{t("help")}</p>
      <p>
        <code>
          {method} {request.path}
        </code>
      </p>
      <pre>
        <code>{JSON.stringify(body, null, 2)}</code>
      </pre>
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
