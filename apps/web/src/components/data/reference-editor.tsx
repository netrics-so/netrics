"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  DATA_TYPES,
  DataProcessingError,
  type DataField,
  type DataType,
} from "@netrics/domain";
import {
  sourceDatasetSchema,
  validateDatasetPage,
  datasetRecordKey,
} from "@netrics/contracts";
import { saveReferencePages, type ReferenceTable } from "@/lib/data-api";
import {
  dataErrorKey,
  referenceCellText,
  referenceRecordPages,
  referenceCellValue,
  newDataId,
  parseEnteredTable,
} from "@/lib/data-editing";
import { useT } from "@/lib/i18n/client";

export function ReferenceEditor({
  workspaceId,
  onSaved,
  onClose,
  onDirty,
  initial,
}: {
  workspaceId: string;
  initial?: ReferenceTable;
  onSaved: () => void;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const t = useT("data"),
    nameId = useId(),
    pasteId = useId();
  const [name, setName] = useState(initial?.definition.name ?? "");
  const [key] = useState(
    () => initial?.definition.key ?? "reference_" + newDataId(),
  );
  const [fields, setFields] = useState<DataField[]>(
    initial?.definition.fields ?? [
      { id: "id", name: "ID", type: "string", nullable: false },
      { id: "name", name: t("name"), type: "string", nullable: true },
    ],
  );
  const [rows, setRows] = useState<string[][]>(() =>
      initial
        ? initial.records.map((record) =>
            initial.definition.fields.map((field) =>
              referenceCellText(field.type, record.values[field.id]),
            ),
          )
        : [["", ""]],
    ),
    [keyFields, setKeyFields] = useState(
      initial?.definition.keyFields ?? ["id"],
    );
  const [paste, setPaste] = useState(""),
    [retention, setRetention] = useState<"days" | "forever">(
      initial?.definition.retentionDays === null || !initial
        ? "forever"
        : "days",
    ),
    [days, setDays] = useState(initial?.definition.retentionDays ?? 30);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const activePage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / 50) - 1),
  );
  const current = JSON.stringify({
    name,
    fields,
    rows,
    keyFields,
    retention,
    days,
  });
  const baseline = useRef(current);
  const dirty = current !== baseline.current || !!paste;
  const [progress, setProgress] = useState<{
    saved: number;
    total: number;
  } | null>(null);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const changeField = (id: string, patch: Partial<DataField>) =>
    setFields((list) =>
      list.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    );
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const definition = sourceDatasetSchema.parse({
        ...initial?.definition,
        key,
        name: name.trim(),
        version: (initial?.definition.version ?? 0) + 1,
        mode: "snapshot",
        keyFields,
        grain: "one reference record",
        retentionDays: retention === "forever" ? null : days,
        fields: fields.map((f) => ({
          ...f,
          nullable: keyFields.includes(f.id) ? false : f.nullable,
          classification:
            initial?.definition.fields.find((field) => field.id === f.id)
              ?.classification ?? "internal",
        })),
      });
      const records = rows.map((row) => ({
        values: Object.fromEntries(
          definition.fields.map((f, index) => {
            if (keyFields.includes(f.id) && !row[index]?.trim())
              throw new DataProcessingError("data_key_invalid");
            const value = referenceCellValue(
              f.type,
              row[index] ?? "",
              f.nullable,
            );
            if (
              keyFields.includes(f.id) &&
              (value === null || (typeof value === "string" && !value.trim()))
            )
              throw new DataProcessingError("data_key_invalid");
            return [f.id, value];
          }),
        ),
      }));
      const keys = records.map((record) =>
        datasetRecordKey(definition, record.values),
      );
      if (new Set(keys).size !== keys.length)
        throw new DataProcessingError("data_key_not_unique");
      for (const page of referenceRecordPages(records))
        validateDatasetPage(definition, {
          datasetKey: key,
          schemaVersion: definition.version,
          refreshKey: "validation",
          pageKey: "validation",
          previousPageKey: null,
          complete: true,
          records: page,
        });
      await saveReferencePages(
        workspaceId,
        {
          definition,
          records,
          ...(initial
            ? {
                datasetId: initial.datasetId,
                generationId: initial.generationId,
              }
            : {}),
        },
        (saved, total) => setProgress({ saved, total }),
      );
      onDirty(false);
      onSaved();
    } catch (failure) {
      setError(t(`errors.${dataErrorKey(failure)}`));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="data-editor" aria-labelledby="reference-title">
      <header className="data-editor-header">
        <div>
          <button className="link-button" type="button" onClick={onClose}>
            {t("back")}
          </button>
          <h2 id="reference-title">
            {t(initial ? "editReference" : "newReference")}
          </h2>
        </div>
      </header>
      <p className="data-intro">{t("referenceHint")}</p>
      {initial ? <p className="notice">{t("referenceEditHint")}</p> : null}
      <p className="help">{t("referenceCellHint")}</p>
      <form onSubmit={(e) => void save(e)}>
        <fieldset disabled={busy} className="data-editor-fields">
          <div className="field data-name-field">
            <label htmlFor={nameId}>{t("referenceName")}</label>
            <input
              id={nameId}
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <details className="data-import">
            <summary>{t("pasteTable")}</summary>
            <div className="field">
              <label htmlFor={pasteId}>{t("pasteTable")}</label>
              <textarea
                id={pasteId}
                rows={5}
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
              />
            </div>
            <button
              type="button"
              disabled={!paste.trim()}
              onClick={() => {
                try {
                  const imported = parseEnteredTable(paste);
                  const fields = imported.fields.map(
                    (field) =>
                      initial?.definition.fields.find(
                        (old) => old.name === field.name,
                      ) ?? field,
                  );
                  setFields(fields);
                  setRows(
                    imported.rows.map((row) =>
                      row.map((cell, index) =>
                        fields[index]?.type === "string" && cell.startsWith('"')
                          ? JSON.stringify(cell)
                          : cell,
                      ),
                    ),
                  );
                  setPage(0);
                  setKeyFields(
                    keyFields.every((key) =>
                      fields.some((field) => field.id === key),
                    )
                      ? keyFields
                      : [fields[0]!.id],
                  );
                  setPaste("");
                  setError(null);
                } catch {
                  setError(t("tableRequired"));
                }
              }}
            >
              {t("importTable")}
            </button>
          </details>
          <div className="data-reference-table data-table-scroll">
            <table className="table">
              <thead>
                <tr>
                  {fields.map((field) => (
                    <th key={field.id} scope="col">
                      <label className="field">
                        {t("columnName")}
                        <input
                          required
                          value={field.name}
                          maxLength={100}
                          onChange={(e) =>
                            changeField(field.id, { name: e.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        {t("type")}
                        <select
                          value={field.type}
                          onChange={(e) =>
                            changeField(field.id, {
                              type: e.target.value as DataType,
                            })
                          }
                        >
                          {DATA_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {t(`types.${type}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                    </th>
                  ))}
                  <th scope="col">{t("rows")}</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .slice(activePage * 50, activePage * 50 + 50)
                  .map((row, offset) => {
                    const index = activePage * 50 + offset;
                    return (
                      <tr key={index}>
                        {fields.map((field, column) => (
                          <td key={field.id}>
                            <input
                              aria-label={field.name + " · " + (index + 1)}
                              value={row[column] ?? ""}
                              onChange={(e) =>
                                setRows((list) =>
                                  list.map((r, i) =>
                                    i === index
                                      ? r.map((cell, j) =>
                                          j === column ? e.target.value : cell,
                                        )
                                      : r,
                                  ),
                                )
                              }
                            />
                          </td>
                        ))}
                        <td>
                          <button
                            type="button"
                            aria-label={t("remove") + " " + (index + 1)}
                            onClick={() =>
                              setRows((list) =>
                                list.filter((_, i) => i !== index),
                              )
                            }
                          >
                            {t("remove")}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <div className="data-form-actions">
            <p className="page-meta">
              {t("rowRange", {
                from: rows.length ? activePage * 50 + 1 : 0,
                to: Math.min(rows.length, activePage * 50 + 50),
                count: rows.length,
              })}
            </p>
            <button
              type="button"
              disabled={activePage === 0}
              onClick={() => setPage(activePage - 1)}
            >
              {t("previous")}
            </button>
            <button
              type="button"
              disabled={(activePage + 1) * 50 >= rows.length}
              onClick={() => setPage(activePage + 1)}
            >
              {t("next")}
            </button>
          </div>
          <div className="data-form-actions">
            <button
              type="button"
              onClick={() => {
                setRows((list) => [...list, fields.map(() => "")]);
                setPage(Math.floor(rows.length / 50));
              }}
            >
              {t("addRow")}
            </button>
            <button
              type="button"
              onClick={() => {
                setFields((list) => [
                  ...list,
                  {
                    id: newDataId(),
                    name: t("columnName") + " " + (fields.length + 1),
                    type: "string",
                    nullable: true,
                  },
                ]);
                setRows((list) => list.map((row) => [...row, ""]));
              }}
            >
              {t("addColumn")}
            </button>
          </div>
          <div className="data-form-grid data-reference-policy">
            <label className="field">
              {t("keyColumn")}
              <select
                multiple
                value={keyFields}
                onChange={(e) =>
                  setKeyFields(
                    Array.from(
                      e.target.selectedOptions,
                      (option) => option.value,
                    ),
                  )
                }
              >
                {fields
                  .filter((f) => f.type !== "json")
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              {t("retention")}
              <select
                value={retention}
                disabled={!!initial}
                onChange={(e) =>
                  setRetention(e.target.value as typeof retention)
                }
              >
                <option value="days">{t("days")}</option>
                <option value="forever">{t("forever")}</option>
              </select>
            </label>
            {retention === "days" ? (
              <label className="field">
                {t("retentionDays")}
                <input
                  type="number"
                  min={1}
                  required
                  value={days}
                  disabled={!!initial}
                  onChange={(e) => setDays(Number(e.target.value))}
                />
              </label>
            ) : null}
          </div>
          <p className="page-meta">{t("retentionHint")}</p>
          {error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : null}
          <div className="data-form-actions">
            <button type="submit" className="primary">
              {t(busy ? "saving" : "saveReference")}
            </button>
            <button type="button" onClick={onClose}>
              {t("cancel")}
            </button>
          </div>
        </fieldset>
        {progress && busy ? (
          <p role="status">{t("referenceSaveProgress", progress)}</p>
        ) : null}
      </form>
    </section>
  );
}
