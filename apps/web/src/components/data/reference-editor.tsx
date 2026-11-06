"use client";
import { useEffect, useId, useState } from "react";
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
import { saveReference } from "@/lib/data-api";
import {
  dataErrorKey,
  enteredValue,
  newDataId,
  parseEnteredTable,
} from "@/lib/data-editing";
import { useT } from "@/lib/i18n/client";

export function ReferenceEditor({
  workspaceId,
  onSaved,
  onClose,
  onDirty,
}: {
  workspaceId: string;
  onSaved: () => void;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const t = useT("data"),
    nameId = useId(),
    pasteId = useId();
  const [name, setName] = useState("");
  const [key] = useState(() => "reference_" + newDataId());
  const [fields, setFields] = useState<DataField[]>([
    { id: "id", name: "ID", type: "string", nullable: false },
    { id: "name", name: t("name"), type: "string", nullable: true },
  ]);
  const [rows, setRows] = useState<string[][]>([["", ""]]),
    [keyField, setKeyField] = useState("id");
  const [paste, setPaste] = useState(""),
    [retention, setRetention] = useState<"days" | "forever">("forever"),
    [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const activePage = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / 50) - 1),
  );
  const dirty =
    !!name ||
    !!paste ||
    rows.some((row) => row.some((value) => !!value)) ||
    fields.length !== 2 ||
    fields[0]?.name !== "ID" ||
    fields[1]?.name !== t("name") ||
    fields.some((field) => field.type !== "string") ||
    retention !== "forever" ||
    days !== 30;
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
      if (!rows.length || !rows.some((row) => row.some((cell) => cell !== "")))
        throw new DataProcessingError("data_table_invalid");
      const definition = sourceDatasetSchema.parse({
        key,
        name: name.trim(),
        version: 1,
        mode: "snapshot",
        keyFields: [keyField],
        grain: "one reference record",
        retentionDays: retention === "forever" ? null : days,
        fields: fields.map((f) => ({
          ...f,
          nullable: f.id === keyField ? false : f.nullable,
          classification: "internal",
        })),
      });
      const records = rows.map((row) => ({
        values: Object.fromEntries(
          definition.fields.map((f, index) => {
            if (f.id === keyField && !row[index]?.trim())
              throw new DataProcessingError("data_key_invalid");
            return [f.id, enteredValue(f.type, row[index] ?? "", f.nullable)];
          }),
        ),
      }));
      const keys = records.map((record) =>
        datasetRecordKey(definition, record.values),
      );
      if (new Set(keys).size !== keys.length)
        throw new DataProcessingError("data_key_not_unique");
      for (let offset = 0; offset < records.length; offset += 1000)
        validateDatasetPage(definition, {
          datasetKey: key,
          schemaVersion: 1,
          refreshKey: "validation",
          pageKey: "validation",
          previousPageKey: null,
          complete: true,
          records: records.slice(offset, offset + 1000),
        });
      await saveReference(workspaceId, { definition, records });
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
          <h2 id="reference-title">{t("newReference")}</h2>
        </div>
      </header>
      <p className="data-intro">{t("referenceHint")}</p>
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
                  setFields(imported.fields);
                  setRows(imported.rows);
                  setPage(0);
                  setKeyField(imported.fields[0]!.id);
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
                value={keyField}
                onChange={(e) => setKeyField(e.target.value)}
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
      </form>
    </section>
  );
}
