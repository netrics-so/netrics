"use client";

import type { ConfigField } from "@/lib/config-schema";

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
  if (fields.length === 0) {
    return <p className="muted">This connector has no configuration.</p>;
  }
  return (
    <>
      {fields.map((field) => {
        const id = `config-${field.key}`;
        const label = field.required
          ? field.label
          : `${field.label} (optional)`;
        const help = field.description ? (
          <p className="help" id={`${id}-help`}>
            {field.description}
          </p>
        ) : null;
        const described = field.description
          ? { "aria-describedby": `${id}-help` }
          : {};
        const value = values[field.key] ?? "";
        if (field.enumValues) {
          return (
            <div className="field" key={field.key}>
              <label htmlFor={id}>{label}</label>
              <select
                id={id}
                {...described}
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(field.key, event.target.value)}
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
            <div className="field" key={field.key}>
              <label htmlFor={id}>{label}</label>
              <select
                id={id}
                {...described}
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(field.key, event.target.value)}
              >
                <option value="">—</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
              {help}
            </div>
          );
        }
        if (field.type === "integer" || field.type === "number") {
          return (
            <div className="field" key={field.key}>
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
                onChange={(event) => onChange(field.key, event.target.value)}
              />
              {help}
            </div>
          );
        }
        const error = errors[field.key];
        return (
          <div className="field" key={field.key}>
            <label htmlFor={id}>{label}</label>
            <input
              id={id}
              {...described}
              type="text"
              value={value}
              disabled={disabled}
              aria-invalid={error ? true : undefined}
              onChange={(event) => onChange(field.key, event.target.value)}
            />
            {help}
            {error ? (
              <p className="field-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
