"use client";
import { useEffect, useId, useRef, useState } from "react";

/** What a confirmation asks: a title, the question, and its two answers. */
export interface Question {
  title: string;
  /** More about what happens, under the title. */
  text?: string;
  confirm: string;
  cancel: string;
  /**
   * The answer loses or removes something: the confirm button is styled as
   * dangerous and the dialog opens with the focus on cancel, so Enter or
   * Space right after it opens never confirms.
   */
  destructive?: boolean;
  /**
   * Confirm stays disabled until the user typed `expected` (a name, for
   * something that cannot be brought back). `label` says what to type.
   */
  typeToConfirm?: { expected: string; label: string };
}

/**
 * Whether what was typed names the thing: the exact name, ignoring space
 * around it. An empty name never matches.
 */
export function typedNameMatches(typed: string, expected: string): boolean {
  const name = expected.trim();
  return name.length > 0 && typed.trim() === name;
}

/**
 * A confirmation in the app's own dialog instead of `window.confirm`
 * (#798): `ask(question)` opens it and settles true on confirm, false on
 * cancel (or Escape). Render `dialog` where the component renders.
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

/**
 * A modal question with confirm and cancel, like the publish dialog. The
 * browser's modal dialog keeps the focus inside and answers Escape with
 * cancel; the focus returns to where it was when the dialog goes.
 */
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
    textId = useId(),
    inputId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const { destructive, typeToConfirm } = question;
  const allowed =
    !typeToConfirm || typedNameMatches(typed, typeToConfirm.expected);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!element.open) element.showModal();
    // Where the focus starts: the name field, else cancel for a destructive
    // answer, else confirm.
    (input.current ?? (destructive ? cancel : confirm).current)?.focus();
    return () => {
      if (element.open) element.close();
      if (opener?.isConnected) opener.focus();
    };
    // Once, when the dialog opens.
  }, []);
  return (
    <dialog
      ref={dialog}
      className="studio-dialog confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={question.text ? textId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId}>{question.title}</h2>
      {question.text ? <p id={textId}>{question.text}</p> : null}
      {typeToConfirm ? (
        <div className="field">
          <label htmlFor={inputId}>{typeToConfirm.label}</label>
          <input
            id={inputId}
            ref={input}
            type="text"
            value={typed}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              // No <form> here: the dialog may sit inside one.
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (allowed) onConfirm();
            }}
          />
        </div>
      ) : null}
      <div className="actions">
        <button
          ref={confirm}
          type="button"
          className={destructive ? "danger" : "primary"}
          disabled={!allowed}
          onClick={onConfirm}
        >
          {question.confirm}
        </button>
        <button ref={cancel} type="button" onClick={onCancel}>
          {question.cancel}
        </button>
      </div>
    </dialog>
  );
}
