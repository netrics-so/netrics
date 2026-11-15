"use client";
import { useEffect, useId, useRef, useState } from "react";

/** What a confirmation asks: a title, the question, and its two answers. */
export interface Question {
  title: string;
  text: string;
  confirm: string;
  cancel: string;
}

/**
 * A confirmation in the app's own dialog instead of `window.confirm`:
 * `ask(question)` opens it and settles true on confirm, false on cancel
 * (or Escape). Render `dialog` where the component renders.
 */
export function useConfirmation() {
  const [state, setState] = useState<{
    question: Question;
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const ask = (question: Question) =>
    new Promise<boolean>((resolve) => {
      setState((current) => {
        // A second question answers the first one with "no".
        current?.resolve(false);
        return { question, resolve };
      });
    });
  const answer = (confirmed: boolean) => {
    state?.resolve(confirmed);
    setState(null);
  };
  const dialog = state ? (
    <ConfirmDialog
      question={state.question}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    />
  ) : null;
  return { ask, dialog };
}

/** A modal question with confirm and cancel, like the publish dialog. */
export function ConfirmDialog({
  question,
  onConfirm,
  onCancel,
}: {
  question: Question;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId(),
    textId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="studio-dialog confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId}>{question.title}</h2>
      <p id={textId}>{question.text}</p>
      <div className="actions">
        <button type="button" className="primary" onClick={onConfirm}>
          {question.confirm}
        </button>
        <button type="button" onClick={onCancel}>
          {question.cancel}
        </button>
      </div>
    </dialog>
  );
}
