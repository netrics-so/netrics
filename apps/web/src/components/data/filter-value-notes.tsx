"use client";
import type { FilterValueNote } from "@netrics/domain";
import { useT } from "@/lib/i18n/client";

/**
 * Filter texts that name neither a value nor a display name of their
 * dimension (#627), so the filter matches nothing, with the value or name
 * that differs only in case or spacing. Never applied silently.
 */
export function FilterValueNotes({
  notes,
  dimensionName,
}: {
  notes: readonly FilterValueNote[] | undefined;
  dimensionName: (id: string) => string;
}) {
  const t = useT("data");
  if (!notes?.length) return null;
  return (
    <aside className="notice" aria-label={t("warnings")}>
      <ul>
        {notes.map((note) => (
          <li key={`${note.dimensionId}\u0000${note.value}`}>
            {t("filterValueUnknown", {
              value: note.value,
              dimension: dimensionName(note.dimensionId),
            })}
            {note.suggestion !== undefined
              ? ` ${t("filterValueSuggestion", { suggestion: note.suggestion })}`
              : ""}
          </li>
        ))}
      </ul>
    </aside>
  );
}
