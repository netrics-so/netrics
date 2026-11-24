"use client";

import {
  initialItemValues,
  readConfigItems,
  writeConfigItems,
  type ConfigField,
} from "@/lib/config-schema";
import { useT } from "@/lib/i18n/client";

interface ConfigFieldsProps {
  fields: ConfigField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
  /** Messages from the server, per field key. */
  errors?: Record<string, string | undefined>;
}

/** Renders one input per manifest configSchema property (subset subset). */
export function ConfigFields({
  fields,
  values,
  onChange,
  disabled,
  errors = {},
}: ConfigFieldsProps) {
  const t = useT("connections.config");
  if (fields.length === 0) {
    return <p className="muted">{t("none")}</p>;
  }
  return (
    <>
      {fields.map((field) =>
        field.type === "array" ? (
          <ConfigList
            key={field.key}
            field={field}
            value={values[field.key] ?? ""}
            disabled={disabled}
            error={errors[field.key]}
            onChange={(value) => onChange(field.key, value)}
          />
        ) : (
          <ScalarField
            key={field.key}
            id={`config-${field.key}`}
            field={field}
            value={values[field.key] ?? ""}
            disabled={disabled}
            error={errors[field.key]}
            onChange={(value) => onChange(field.key, value)}
          />
        ),
      )}
    </>
  );
}

interface ScalarFieldProps {
  id: string;
  field: ConfigField;
  value: string;
  disabled?: boolean | undefined;
  error?: string | undefined;
  onChange: (value: string) => void;
}

function ScalarField({
  id,
  field,
  value,
  disabled,
  error,
  onChange,
}: ScalarFieldProps) {
  const t = useT("connections.config");
  const label = field.required
    ? field.label
    : t("optionalLabel", { label: field.label });
  const help = field.description ? (
    <p className="help" id={`${id}-help`}>
      {field.description}
    </p>
  ) : null;
  const described = field.description
    ? { "aria-describedby": `${id}-help` }
    : {};
  if (field.enumValues) {
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          {...described}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          {field.enumValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {help}
      </div>
    );
  }
  if (field.type === "boolean") {
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          {...described}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          <option value="true">{t("yes")}</option>
          <option value="false">{t("no")}</option>
        </select>
        {help}
      </div>
    );
  }
  if (field.type === "integer" || field.type === "number") {
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          {...described}
          type="number"
          value={value}
          disabled={disabled}
          {...(field.type === "integer" ? { step: 1 } : {})}
          {...(field.minimum !== undefined ? { min: field.minimum } : {})}
          {...(field.maximum !== undefined ? { max: field.maximum } : {})}
          onChange={(event) => onChange(event.target.value)}
        />
        {help}
      </div>
    );
  }
  const common = {
    id,
    ...described,
    value,
    disabled,
    ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
    "aria-invalid": error ? true : undefined,
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {field.multiline ? (
        <textarea
          {...common}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          {...common}
          type="text"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {help}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface ConfigListProps {
  field: ConfigField;
  value: string;
  disabled?: boolean | undefined;
  error?: string | undefined;
  onChange: (value: string) => void;
}

/**
 * An array of objects (#874): one fieldset per entry with the item fields,
 * and buttons to add an entry (up to maxItems) and to remove one (down to
 * minItems).
 */
function ConfigList({
  field,
  value,
  disabled,
  error,
  onChange,
}: ConfigListProps) {
  const t = useT("connections.config");
  const items = readConfigItems(value);
  const itemFields = field.itemFields ?? [];
  const max = field.maxItems;
  const min = field.minItems ?? 0;
  const id = `config-${field.key}`;
  const update = (next: Record<string, string>[]) =>
    onChange(writeConfigItems(next));
  return (
    <fieldset className="stack" aria-describedby={`${id}-help`}>
      <legend>
        {field.required
          ? field.label
          : t("optionalLabel", { label: field.label })}
      </legend>
      <p className="help" id={`${id}-help`}>
        {field.description ? `${field.description} ` : ""}
        {max !== undefined ? t("listLimit", { max }) : null}
      </p>
      {items.map((item, index) => (
        <fieldset key={index} className="stack" data-testid={`${id}-entry`}>
          <legend>{t("listItem", { number: index + 1 })}</legend>
          {itemFields.map((itemField) => (
            <ScalarField
              key={itemField.key}
              id={`${id}-${index}-${itemField.key}`}
              field={itemField}
              value={item[itemField.key] ?? ""}
              disabled={disabled}
              onChange={(next) =>
                update(
                  items.map((entry, at) =>
                    at === index ? { ...entry, [itemField.key]: next } : entry,
                  ),
                )
              }
            />
          ))}
          {items.length > min ? (
            <div className="actions">
              <button
                type="button"
                disabled={disabled}
                onClick={() => update(items.filter((_, at) => at !== index))}
              >
                {t("removeItem", { number: index + 1 })}
              </button>
            </div>
          ) : null}
        </fieldset>
      ))}
      {max === undefined || items.length < max ? (
        <div className="actions">
          <button
            type="button"
            disabled={disabled}
            onClick={() => update([...items, initialItemValues(itemFields)])}
          >
            {t("addItem")}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
