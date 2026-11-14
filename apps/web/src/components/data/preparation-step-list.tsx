"use client";
import { useId } from "react";
import type { PreparationNode } from "@netrics/domain";
import { useT } from "@/lib/i18n/client";
import type { PreparationStepState } from "@/lib/preparation-editing";

/** The preparation steps, with the failed step and the steps that read its result marked. */
export function PreparationStepList({
  nodes,
  selected,
  states,
  failure,
  label,
  disabled,
  onSelect,
}: {
  nodes: PreparationNode[];
  selected: string;
  states: ReadonlyMap<string, PreparationStepState>;
  /** Translated message for the failed step, and the column it names (display name, or id when unknown). */
  failure: { message: string; column?: string } | null;
  label: (node: PreparationNode) => { title: string; detail?: string };
  disabled: boolean;
  onSelect: (nodeId: string) => void;
}) {
  const t = useT("data"),
    listId = useId();
  return (
    <ol className="data-step-list">
      {nodes.map((node, index) => {
        const state = states.get(node.id);
        const { title, detail } = label(node);
        const noteId =
          state === "affected" || (state === "failed" && failure)
            ? `${listId}-note-${index}`
            : undefined;
        return (
          <li key={node.id} data-state={state}>
            <button
              type="button"
              aria-current={node.id === selected ? "step" : undefined}
              aria-describedby={noteId}
              disabled={disabled}
              onClick={() => onSelect(node.id)}
            >
              <span>{title}</span>
              {detail ? <small>{detail}</small> : null}
              {state ? (
                <small className="data-step-status">
                  {t(`stepStatus.${state}`)}
                </small>
              ) : null}
            </button>
            {state === "failed" && failure ? (
              <p id={noteId} className="error" role="alert">
                {t("stepFailed", { message: failure.message })}
                {failure.column
                  ? " " + t("stepFailedColumn", { column: failure.column })
                  : null}
              </p>
            ) : null}
            {state === "affected" ? (
              <p id={noteId} className="help">
                {t("stepAffected")}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
