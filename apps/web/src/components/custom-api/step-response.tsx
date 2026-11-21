"use client";

import { useState } from "react";

import {
  parseDataPath,
  readDataPath,
  type CustomApiFieldSuggestion,
} from "@netrics/contracts";

import { DataTable } from "@/components/data/data-table";
import { toggleField } from "@/lib/custom-api-builder";
import { useT } from "@/lib/i18n/client";

import { FieldMapping } from "./field-mapping";
import { JsonTree } from "./json-tree";
import type { StepProps } from "./step-props";

type Json = Parameters<typeof JsonTree>[0]["value"];

const isObject = (value: unknown): value is Record<string, Json> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The first record at the records path of a response body (an object). */
export function firstRecord(body: Json, records: string): Json | undefined {
  let value: unknown;
  try {
    value = readDataPath(body, parseDataPath(records));
  } catch {
    return undefined;
  }
  if (Array.isArray(value)) return value.find(isObject);
  return isObject(value) ? value : undefined;
}

/** A field for a leaf the server did not suggest (beyond the first records). */
function plainSuggestion(path: string): CustomApiFieldSuggestion {
  const id =
    path
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(?![a-z])/, "f_")
      .slice(0, 90) || "field";
  return {
    path,
    id,
    name: path,
    type: "string",
    nullable: true,
    samples: [],
  };
}

/**
 * Step 4: the response as a tree; pick the record list, tick the fields,
 * check their types and see the mapped rows.
 */
export function StepResponse({
  state,
  update,
  pending,
  previewStale,
  onPickRecords,
  onRefresh,
}: StepProps & {
  pending: boolean;
  /** The fields changed since the last test. */
  previewStale: boolean;
  /** Picks the record list and tests again for its fields. */
  onPickRecords: (path: string) => void;
  onRefresh: () => void;
}) {
  const t = useT("customApi.response");
  const [choosing, setChoosing] = useState(false);
  const test = state.lastTest;
  const body = test?.response?.body;
  if (!test || body === undefined)
    return <p className="muted">{t("noTest")}</p>;

  const records = state.stream.records;
  if (records === null || choosing) {
    return (
      <div className="custom-api-form">
        <p>{t("pickRecords")}</p>
        <JsonTree
          key={`records-${test.response?.bytes}`}
          value={body}
          mode="records"
          recordPath={records}
          suggestedPath={test.recordArrays[0]?.path ?? null}
          fieldPaths={new Set()}
          onPickRecords={(path) => {
            setChoosing(false);
            onPickRecords(path);
          }}
        />
        {isObject(body) ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setChoosing(false);
              onPickRecords("");
            }}
          >
            {t("wholeResponse")}
          </button>
        ) : null}
      </div>
    );
  }

  const counted = test.records.path === records;
  const record = firstRecord(body, records);
  const fieldPaths = new Set(state.stream.fields.map((f) => f.path));
  const suggestion = (path: string) =>
    (counted ? test.suggestions.find((s) => s.path === path) : undefined) ??
    plainSuggestion(path);
  const fields = state.stream.fields;

  return (
    <div className="custom-api-form">
      <p className="custom-api-records">
        <span>
          {t("recordsAt", {
            path: records === "" ? t("wholeResponse") : records,
            count: counted ? test.records.count : 0,
          })}
        </span>{" "}
        <button
          type="button"
          className="link-button"
          onClick={() => setChoosing(true)}
        >
          {t("changeRecords")}
        </button>
      </p>
      {counted && test.records.found && test.records.count === 0 ? (
        <p className="notice" role="status">
          {t("noRecords")}
        </p>
      ) : null}
      {!counted ? (
        <p className="help">
          {pending ? null : (
            <button type="button" onClick={onRefresh}>
              {t("updatePreview")}
            </button>
          )}
        </p>
      ) : record !== undefined ? (
        <>
          <p>{t("pickFields")}</p>
          <JsonTree
            key={`fields-${records}-${test.response?.bytes}`}
            value={record}
            mode="fields"
            recordPath={records}
            fieldPaths={fieldPaths}
            onToggleField={(path, on) =>
              update((current) => toggleField(current, suggestion(path), on))
            }
          />
        </>
      ) : null}
      <FieldMapping
        state={state}
        update={update}
        suggestions={counted ? test.suggestions : []}
      />
      {fields.length ? (
        <section className="custom-api-preview">
          <h3>{t("preview", { count: test.rows.length })}</h3>
          {previewStale ? (
            <p className="help">
              {t("previewStale")}{" "}
              <button type="button" disabled={pending} onClick={onRefresh}>
                {t("updatePreview")}
              </button>
            </p>
          ) : null}
          {test.mapping.skipped > 0 ? (
            <p className="notice" role="status">
              {t("skipped", { count: test.mapping.skipped })}
            </p>
          ) : null}
          {Object.entries(test.mapping.nulled)
            .filter(([, count]) => count > 0)
            .map(([field, count]) => (
              <p className="help" key={field}>
                {t("nulled", {
                  field: fields.find((f) => f.id === field)?.name ?? field,
                  count,
                })}
              </p>
            ))}
          <DataTable
            fields={fields
              .filter((f) => test.rows.some((row) => f.id in row))
              .map((f) => ({
                id: f.id,
                name: f.name,
                type: f.type,
                nullable: f.nullable,
                ...(f.unit ? { unit: f.unit } : {}),
              }))}
            rows={test.rows}
          />
        </section>
      ) : null}
    </div>
  );
}
