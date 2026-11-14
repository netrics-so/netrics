"use client";
import { useId, useState } from "react";
import type { DataLiteral, DataType } from "@netrics/domain";
import { useLocale, useT } from "@/lib/i18n/client";
import {
  listFromInput,
  literalEdit,
  literalFromInput,
  literalInputText,
} from "@/lib/literal-input";

/** A literal not filled in yet: `fromVisual` reads it as incomplete. */
export function emptyLiteral(type: DataType): DataLiteral {
  return {
    kind: "literal",
    type,
    value: type === "boolean" ? false : null,
  };
}

/**
 * Local input text that follows the literal: when the literal changes from
 * outside (another column, a reset), the text is read from it again.
 */
function useLiteralText<T>(
  literal: T,
  text: (literal: T) => string[],
): [string[], (next: string[], emitted: T) => void] {
  const [state, setState] = useState(() => ({
    literal,
    text: text(literal),
  }));
  let current = state;
  if (state.literal !== literal) {
    current = { literal, text: text(literal) };
    setState(current);
  }
  return [
    current.text,
    (next, emitted) => setState({ literal: emitted, text: next }),
  ];
}

/** A typed input for one literal: date, datetime (UTC), number, switch or text. */
export function LiteralField({
  label,
  type,
  literal,
  onChange,
  currency = false,
  invalid = false,
}: {
  label: string;
  type: DataType;
  literal: DataLiteral | undefined;
  onChange: (literal: DataLiteral) => void;
  /** Offer a currency code next to a decimal value. */
  currency?: boolean;
  invalid?: boolean;
}) {
  const t = useT("data"),
    locale = useLocale(),
    id = useId();
  const [[text = "", code = ""], setText] = useLiteralText(literal, (l) => [
    // A stored literal of another type (an integer in a decimal column)
    // still shows its value; the caller picks a type that can read it.
    l ? literalInputText(l, locale) : "",
    l?.currency ?? "",
  ]);
  const emit = (nextText: string, nextCode: string) => {
    const next = literalEdit(type, nextText, nextCode, locale, literal);
    setText([nextText, nextCode], next);
    onChange(next);
  };
  const bad =
    text !== "" &&
    type !== "boolean" &&
    literalFromInput(type, text, locale) === null;
  const errorId = id + "-error";
  if (type === "boolean") {
    const on = literal?.value === true;
    return (
      <div className="field">
        <span id={id + "-label"}>{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={id + "-label"}
          className="data-builder-switch"
          onClick={() => emit(on ? "false" : "true", "")}
        >
          {t(on ? "builder.true" : "builder.false")}
        </button>
      </div>
    );
  }
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span className="data-builder-inline">
        <input
          id={id}
          type={
            type === "date"
              ? "date"
              : type === "timestamp"
                ? "datetime-local"
                : "text"
          }
          step={type === "timestamp" ? 1 : undefined}
          inputMode={
            type === "integer"
              ? "numeric"
              : type === "number" || type === "decimal"
                ? "decimal"
                : undefined
          }
          value={text}
          aria-invalid={invalid || bad || undefined}
          aria-describedby={bad ? errorId : undefined}
          onChange={(e) => emit(e.target.value, code)}
        />
        {type === "timestamp" ? <span>{t("builder.utc")}</span> : null}
      </span>
      {currency && type === "decimal" ? (
        <span className="data-builder-inline">
          <label htmlFor={id + "-currency"}>{t("builder.currency")}</label>
          <input
            id={id + "-currency"}
            className="data-builder-currency"
            maxLength={3}
            value={code}
            onChange={(e) => emit(text, e.target.value.toUpperCase())}
          />
        </span>
      ) : null}
      {bad ? (
        <p id={errorId} className="help">
          {t("builder.invalidValue", { type: t(`types.${type}`) })}
        </p>
      ) : null}
    </div>
  );
}

/** The value list of an `in` comparison: one typed input per item. */
export function ListField({
  label,
  type,
  literal,
  onChange,
  invalid = false,
}: {
  label: string;
  type: DataType;
  literal: DataLiteral | undefined;
  onChange: (literal: DataLiteral) => void;
  invalid?: boolean;
}) {
  const t = useT("data"),
    locale = useLocale(),
    id = useId();
  const [items, setItems] = useLiteralText(literal, (l) =>
    l && Array.isArray(l.value)
      ? l.value.map((item) =>
          literalInputText(
            { kind: "literal", type, value: item as unknown },
            locale,
          ),
        )
      : [""],
  );
  const emit = (next: string[]) => {
    const list = listFromInput(type, next, locale) ?? {
      kind: "literal" as const,
      type: "json" as const,
      value: null,
    };
    setItems(next, list);
    onChange(list);
  };
  return (
    <fieldset className="data-builder-list">
      <legend>{label}</legend>
      {items.map((item, index) => (
        <span className="data-builder-inline" key={index}>
          {type === "boolean" ? (
            <select
              aria-label={label + " " + (index + 1)}
              aria-invalid={invalid || undefined}
              value={item}
              onChange={(e) =>
                emit(items.map((v, i) => (i === index ? e.target.value : v)))
              }
            >
              <option value="">{t("choose")}</option>
              <option value="true">{t("builder.true")}</option>
              <option value="false">{t("builder.false")}</option>
            </select>
          ) : (
            <input
              id={index === 0 ? id : undefined}
              aria-label={label + " " + (index + 1)}
              type={
                type === "date"
                  ? "date"
                  : type === "timestamp"
                    ? "datetime-local"
                    : "text"
              }
              step={type === "timestamp" ? 1 : undefined}
              value={item}
              aria-invalid={
                invalid ||
                (item !== "" && !literalFromInput(type, item, locale)) ||
                undefined
              }
              onChange={(e) =>
                emit(items.map((v, i) => (i === index ? e.target.value : v)))
              }
            />
          )}
          {items.length > 1 ? (
            <button
              type="button"
              aria-label={t("builder.removeValue", { number: index + 1 })}
              onClick={() => emit(items.filter((_, i) => i !== index))}
            >
              {t("builder.remove")}
            </button>
          ) : null}
        </span>
      ))}
      <button type="button" onClick={() => emit([...items, ""])}>
        {t("builder.addValue")}
      </button>
    </fieldset>
  );
}
