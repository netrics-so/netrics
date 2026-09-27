"use client";

import type { ConfigField } from "@/lib/config-schema";

interface ConfigFieldsProps {
  fields: ConfigField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}

/** Renders one input per manifest configSchema property (subset subset). */
export function ConfigFields({
  fields,
  values,
  onChange,
  disabled,
}: ConfigFieldsProps) {
  if (fields.length === 0) {
    return <p className="muted">This connector has no configuration.</p>;
  }
  return (
    <>
      {fields.map((field) => {
        const id = `config-${field.key}`;
        const label = field.required ? field.key : `${field.key} (optional)`;
        const value = values[field.key] ?? "";
        if (field.enumValues) {
          return (
            <div className="field" key={field.key}>
              <label htmlFor={id}>{label}</label>
              <select
                id={id}
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
            </div>
          );
        }
        if (field.type === "boolean") {
          return (
            <div className="field" key={field.key}>
              <label htmlFor={id}>{label}</label>
              <select
                id={id}
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(field.key, event.target.value)}
              >
                <option value="">—</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </div>
          );
        }
        if (field.type === "integer" || field.type === "number") {
          return (
            <div className="field" key={field.key}>
              <label htmlFor={id}>{label}</label>
              <input
                id={id}
                type="number"
                value={value}
                disabled={disabled}
                {...(field.type === "integer" ? { step: 1 } : {})}
                {...(field.minimum !== undefined ? { min: field.minimum } : {})}
                {...(field.maximum !== undefined ? { max: field.maximum } : {})}
                onChange={(event) => onChange(field.key, event.target.value)}
              />
            </div>
          );
        }
        return (
          <div className="field" key={field.key}>
            <label htmlFor={id}>{label}</label>
            <input
              id={id}
              type="text"
              value={value}
              disabled={disabled}
              onChange={(event) => onChange(field.key, event.target.value)}
            />
          </div>
        );
      })}
    </>
  );
}
