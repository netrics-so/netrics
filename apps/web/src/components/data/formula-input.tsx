"use client";
import {
  Fragment,
  type KeyboardEvent,
  type SyntheticEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  applyFormulaCompletion,
  formatDataFormula,
  formulaArgumentHint,
  formulaCompletions,
  type DataField,
  type FormulaCompletion,
} from "@netrics/domain";
import { useT } from "@/lib/i18n/client";
import type { BuilderNoun } from "./condition-builder";

/** Suggestions open by themselves while a name is typed or after an operand. */
function opensByItself(
  result: ReturnType<typeof formulaCompletions>,
  cursor: number,
): boolean {
  return (
    result.items.length > 0 &&
    (result.from < cursor || result.items[0]!.kind === "operator")
  );
}

/**
 * The formula textarea with suggestions (functions, columns, operators), the
 * current function's parameters, help text and "Insert a column" buttons.
 */
export function FormulaInput({
  id,
  value,
  fields,
  onChange,
  describedBy,
  noun = "column",
}: {
  id: string;
  value: string;
  fields: readonly DataField[];
  onChange: (text: string) => void;
  describedBy?: string;
  /** What the fields are, for the suggestion list. */
  noun?: BuilderNoun;
}) {
  const t = useT("data");
  const input = useRef<HTMLTextAreaElement>(null);
  // Until the field is used, the cursor is at the end of the text.
  const [selection, setSelection] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const pendingCursor = useRef<number | null>(null);
  const cursor =
    selection === null ? value.length : Math.min(selection, value.length);
  const result = useMemo(
    () => formulaCompletions(value, cursor, fields),
    [value, cursor, fields],
  );
  const hint = useMemo(
    () => formulaArgumentHint(value, cursor),
    [value, cursor],
  );
  const items = open ? result.items : [];
  const expanded = items.length > 0;
  const current = Math.min(active, Math.max(items.length - 1, 0));
  const listId = id + "-suggestions",
    hintId = id + "-hint";

  useEffect(() => {
    const at = pendingCursor.current;
    if (at === null || !input.current) return;
    pendingCursor.current = null;
    input.current.setSelectionRange(at, at);
  }, [value]);

  const accept = (item: FormulaCompletion) => {
    const next = applyFormulaCompletion(value, result, item);
    pendingCursor.current = next.cursor;
    setSelection(next.cursor);
    setOpen(false);
    onChange(next.text);
  };
  const track = (event: SyntheticEvent<HTMLTextAreaElement>) =>
    setSelection(event.currentTarget.selectionStart);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.ctrlKey && (event.key === " " || event.code === "Space")) {
      event.preventDefault();
      setActive(0);
      setOpen(true);
      return;
    }
    if (!expanded) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + items.length) % items.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(items[current]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };
  const kindLabel = (item: FormulaCompletion) =>
    t(
      `completion.kinds.${item.kind === "field" && noun === "measure" ? "measure" : item.kind}`,
    );
  const highlighted = hint
    ? hint.argument < hint.signature.params.length
      ? hint.argument
      : hint.signature.rest
        ? hint.signature.params.length - 1
        : -1
    : -1;

  return (
    <>
      <textarea
        ref={input}
        id={id}
        value={value}
        onChange={(e) => {
          const at = e.target.selectionStart;
          setSelection(at);
          setActive(0);
          setOpen(
            opensByItself(formulaCompletions(e.target.value, at, fields), at),
          );
          onChange(e.target.value);
        }}
        onSelect={track}
        onClick={track}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        required
        rows={3}
        maxLength={10000}
        placeholder={t("formulaPlaceholder")}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={
          expanded ? `${id}-suggestion-${current}` : undefined
        }
        aria-describedby={[describedBy, hint ? hintId : null, id + "-help"]
          .filter(Boolean)
          .join(" ")}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={t("completion.label")}
        className="data-formula-suggestions"
        hidden={!expanded}
      >
        {items.map((item, index) => (
          <li
            key={item.kind + item.insert}
            id={`${id}-suggestion-${index}`}
            role="option"
            aria-selected={index === current}
            onMouseDown={(e) => {
              // Keep focus in the textarea.
              e.preventDefault();
              accept(item);
            }}
          >
            <span>{item.label}</span>
            <span className="help">
              {kindLabel(item)}
              {item.type ? " · " + t(`types.${item.type}`) : ""}
            </span>
          </li>
        ))}
      </ul>
      {hint ? (
        <p id={hintId} className="help data-formula-hint" aria-live="polite">
          {hint.fn}(
          {hint.signature.params.map((param, index) => {
            const name = t(`completion.params.${param.name}`);
            return (
              <Fragment key={index}>
                {index > 0 ? ", " : ""}
                {index === highlighted ? <strong>{name}</strong> : name}
              </Fragment>
            );
          })}
          {hint.signature.rest ? ", …" : ""})
        </p>
      ) : null}
      <p id={id + "-help"} className="help">
        {t("formulaHelp")}
      </p>
      <div className="data-reference-buttons" aria-label={t("insertColumn")}>
        {fields.map((f) => (
          <button
            type="button"
            key={f.id}
            onClick={() =>
              onChange(
                value +
                  formatDataFormula({ kind: "field", fieldId: f.id }, fields),
              )
            }
          >
            {f.name}
          </button>
        ))}
      </div>
    </>
  );
}
