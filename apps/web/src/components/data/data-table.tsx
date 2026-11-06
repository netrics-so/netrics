"use client";
import { useEffect, useRef } from "react";
import type { DataField } from "@netrics/domain";
import { useLocale, useT } from "@/lib/i18n/client";
export function DataTable({
  fields,
  rows,
  loading = false,
  focusColumn,
}: {
  fields: DataField[];
  rows: Array<Record<string, unknown>>;
  loading?: boolean;
  focusColumn?: string;
}) {
  const t = useT("data"),
    locale = useLocale();
  const focused = useRef<HTMLTableCellElement>(null);
  useEffect(() => {
    if (focusColumn)
      focused.current?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [focusColumn, fields]);
  return (
    <div className="data-table-scroll" aria-busy={loading}>
      {loading ? (
        <p role="status" className="data-loading">
          {t("loading")}
        </p>
      ) : null}
      {fields.length ? (
        <table className="table data-table">
          <thead>
            <tr>
              {fields.map((field) => (
                <th
                  key={field.id}
                  scope="col"
                  ref={field.id === focusColumn ? focused : undefined}
                >
                  <span>{field.name}</span>
                  <small>
                    {t(`types.${field.type}`)}
                    {field.unit ? " · " + field.unit : ""}
                  </small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {fields.map((field) => {
                  const value = row[field.id];
                  const text =
                    value === null || value === undefined
                      ? t("nullValue")
                      : typeof value === "boolean"
                        ? t(value ? "true" : "false")
                        : typeof value === "number"
                          ? new Intl.NumberFormat(locale, {
                              maximumFractionDigits: 12,
                            }).format(value)
                          : typeof value === "object"
                            ? JSON.stringify(value)
                            : String(value);
                  return (
                    <td
                      key={field.id}
                      className={
                        value === null
                          ? "muted"
                          : ["decimal", "integer", "number"].includes(
                                field.type,
                              )
                            ? "data-number"
                            : undefined
                      }
                      title={text}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {!loading && !rows.length ? (
        <p className="data-empty-rows">{t("noRows")}</p>
      ) : null}
    </div>
  );
}
