"use client";

import type {
  CustomApiField,
  CustomApiFieldSuggestion,
} from "@netrics/contracts";

import {
  chooseKey,
  setFieldType,
  suggestedTimeKey,
  updateField,
  type FieldType,
} from "@/lib/custom-api-builder";
import { useT } from "@/lib/i18n/client";

import type { StepProps } from "./step-props";

export const FIELD_TYPES: readonly (FieldType | "image")[] = [
  "string",
  "boolean",
  "integer",
  "number",
  "decimal",
  "date",
  "timestamp",
  "json",
  "image",
];

/** A field's type as the type select shows it ("image" for image URLs). */
export const typeOf = (
  field: Pick<CustomApiField, "type" | "role">,
): FieldType | "image" => (field.role === "image" ? "image" : field.type);

const NUMERIC = new Set<string>(["integer", "number", "decimal"]);
const MONEY = new Set<string>(["integer", "decimal"]);

/**
 * The ticked fields: name, type (with the suggestion), unit and currency
 * for numbers, may be empty, classification, key; then the time field.
 */
export function FieldMapping({
  state,
  update,
  suggestions,
}: StepProps & { suggestions: readonly CustomApiFieldSuggestion[] }) {
  const t = useT("customApi.response");
  const fields = state.stream.fields;
  const key = state.stream.keyFields[0] ?? null;
  const strings = fields.filter((f) => f.type === "string" && !f.role);
  const times = fields.filter(
    (f) => f.type === "date" || f.type === "timestamp",
  );
  if (fields.length === 0) return null;
  const timeKey = suggestedTimeKey(state);
  const keyName = fields.find((f) => f.id === key)?.name ?? "";
  return (
    <div className="custom-api-mapping">
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>{t("columns.field")}</th>
              <th>{t("columns.name")}</th>
              <th>{t("columns.type")}</th>
              <th>{t("columns.unit")}</th>
              <th>{t("columns.nullable")}</th>
              <th>{t("columns.classification")}</th>
              <th>{t("key")}</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => {
              const suggestion = suggestions.find((s) => s.path === field.path);
              const suggested = suggestion
                ? typeOf({ type: suggestion.type, role: suggestion.role })
                : null;
              const id = `custom-api-field-${field.id}`;
              return (
                <tr key={field.id}>
                  <td>
                    <code>{field.path}</code>
                  </td>
                  <td>
                    <input
                      aria-label={`${field.path}: ${t("columns.name")}`}
                      value={field.name}
                      maxLength={100}
                      onChange={(event) =>
                        update((current) =>
                          updateField(current, field.id, {
                            name: event.target.value,
                          }),
                        )
                      }
                    />
                  </td>
                  <td>
                    <select
                      id={`${id}-type`}
                      aria-label={`${field.path}: ${t("columns.type")}`}
                      value={typeOf(field)}
                      onChange={(event) =>
                        update((current) =>
                          setFieldType(
                            current,
                            field.id,
                            event.target.value as FieldType | "image",
                          ),
                        )
                      }
                    >
                      {FIELD_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {t(`types.${type}`)}
                        </option>
                      ))}
                    </select>
                    {suggested ? (
                      <p className="help">
                        {t("suggested", { type: t(`types.${suggested}`) })}
                      </p>
                    ) : null}
                  </td>
                  <td>
                    {NUMERIC.has(field.type) ? (
                      <input
                        aria-label={`${field.path}: ${t("columns.unit")}`}
                        value={field.unit ?? ""}
                        maxLength={100}
                        onChange={(event) =>
                          update((current) =>
                            updateField(current, field.id, {
                              unit: event.target.value || undefined,
                            }),
                          )
                        }
                      />
                    ) : null}
                    {MONEY.has(field.type) && strings.length ? (
                      <select
                        aria-label={`${field.path}: ${t("columns.currency")}`}
                        value={field.currencyField ?? ""}
                        onChange={(event) =>
                          update((current) => {
                            const currencyField =
                              event.target.value || undefined;
                            let next = updateField(current, field.id, {
                              currencyField,
                            });
                            // Money needs a currency that is never empty.
                            if (currencyField)
                              next = updateField(next, currencyField, {
                                nullable: false,
                              });
                            return next;
                          })
                        }
                      >
                        <option value="">{t("columns.currency")}: –</option>
                        {strings.map((s) => (
                          <option key={s.id} value={s.id}>
                            {t("columns.currency")}: {s.name}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${field.path}: ${t("columns.nullable")}`}
                      checked={field.nullable}
                      disabled={key === field.id}
                      onChange={(event) =>
                        update((current) =>
                          updateField(current, field.id, {
                            nullable: event.target.checked,
                          }),
                        )
                      }
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`${field.path}: ${t("columns.classification")}`}
                      value={field.classification}
                      onChange={(event) => {
                        const classification = event.target
                          .value as CustomApiField["classification"];
                        update((current) =>
                          updateField(current, field.id, {
                            classification,
                            retentionDays:
                              classification === "personal"
                                ? (field.retentionDays ?? 90)
                                : undefined,
                          }),
                        );
                      }}
                    >
                      {(["public", "internal", "personal"] as const).map(
                        (value) => (
                          <option key={value} value={value}>
                            {t(`classifications.${value}`)}
                          </option>
                        ),
                      )}
                    </select>
                    {field.classification === "personal" ? (
                      <input
                        type="number"
                        min={1}
                        aria-label={`${field.path}: ${t("columns.retention")}`}
                        value={field.retentionDays ?? ""}
                        onChange={(event) =>
                          update((current) =>
                            updateField(current, field.id, {
                              retentionDays:
                                Number(event.target.value) || undefined,
                            }),
                          )
                        }
                      />
                    ) : null}
                  </td>
                  <td>
                    <input
                      type="radio"
                      name="custom-api-key"
                      aria-label={`${field.path}: ${t("keyField")}`}
                      checked={key === field.id}
                      onChange={() =>
                        update((current) =>
                          chooseKey(current, { keyField: field.id }),
                        )
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {timeKey ? (
        <p className="help" role="status">
          {t("timeKey", { key: keyName, time: timeKey.name })}{" "}
          <button
            type="button"
            className="link-button"
            onClick={() =>
              update((current) => chooseKey(current, { keyField: timeKey.id }))
            }
          >
            {t("useTimeKey", { time: timeKey.name })}
          </button>
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="custom-api-time-field">{t("timeField")}</label>
        <select
          id="custom-api-time-field"
          value={state.stream.reportingField ?? ""}
          onChange={(event) =>
            update((current) =>
              chooseKey(current, {
                reportingField: event.target.value || null,
              }),
            )
          }
        >
          <option value="">{t("noTimeField")}</option>
          {times.map((field) => (
            <option key={field.id} value={field.id}>
              {field.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
