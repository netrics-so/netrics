"use client";

import { useId, useState, type ChangeEvent } from "react";

import {
  keyFieldHint,
  keyIdFromFileName,
  localizeSignedKeyStrategy,
  privateKeyHint,
  type SignedKeyField,
  type SignedKeyStrategy,
} from "@/lib/signed-key";
import { useLocale, useT } from "@/lib/i18n/client";

const PEM_PLACEHOLDER =
  "-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----";

interface SignedKeyFieldsProps {
  strategy: SignedKeyStrategy;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Messages from the server, per field key. */
  errors?: Record<string, string | undefined>;
  disabled?: boolean;
  /** Show the setup steps open (new connection, or a refused key). */
  guideOpen?: boolean;
  /**
   * Other setup steps than the provider's (e.g. for a temporary Admin key),
   * with their own summary line.
   */
  guide?: {
    summary: string;
    steps: readonly string[];
    links?: readonly { step: number; label: string; url: string }[];
  };
  /** Prefix of the field ids, when two key forms share a page. */
  idPrefix?: string;
}

/**
 * The key form of a signed-key provider (ADR 0014): the provider's setup
 * steps with deep links, its text fields with format hints, and the
 * private key as a file (read in the browser, never shown) or pasted.
 */
export function SignedKeyFields({
  strategy: serverStrategy,
  values,
  onChange,
  errors = {},
  disabled,
  guideOpen,
  guide,
  idPrefix = "",
}: SignedKeyFieldsProps) {
  const locale = useLocale();
  const t = useT("connections.signedKey");
  const strategy = localizeSignedKeyStrategy(serverStrategy, locale);
  const setup = guide ?? strategy.setup;
  const name = strategy.providerName ?? t("theProvider");
  return (
    <>
      {setup ? (
        <details className="setup-guide" open={guideOpen}>
          <summary>{guide?.summary ?? t("howToCreate", { name })}</summary>
          <ol>
            {setup.steps.map((step, index) => {
              const links = (setup.links ?? []).filter(
                (link) => link.step === index,
              );
              return (
                <li key={step}>
                  {step}
                  {links.map((link) => (
                    <span key={link.url}>
                      {" "}
                      <a href={link.url} target="_blank" rel="noreferrer">
                        {link.label} ↗
                      </a>
                    </span>
                  ))}
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}
      {strategy.fields.map((field) =>
        field.input === "file" ? (
          <KeyFileField
            key={field.key}
            field={field}
            value={values[field.key] ?? ""}
            error={errors[field.key]}
            disabled={disabled}
            onChange={(value) => onChange(field.key, value)}
            onFileName={(fileName, previousName) => {
              // AuthKey_<Key ID>.p8: fill the key ID from the name when it
              // is empty or was filled from the previous file.
              const keyId = keyIdFromFileName(fileName);
              const current = (values.keyId ?? "").trim().toUpperCase();
              const previous = previousName
                ? keyIdFromFileName(previousName)
                : null;
              if (
                keyId &&
                strategy.fields.some((other) => other.key === "keyId") &&
                (current === "" || current === previous)
              ) {
                onChange("keyId", keyId);
              }
            }}
          />
        ) : (
          <KeyTextField
            key={field.key}
            idPrefix={idPrefix}
            provider={strategy.provider}
            field={field}
            value={values[field.key] ?? ""}
            error={errors[field.key]}
            disabled={disabled}
            onChange={(value) => onChange(field.key, value)}
          />
        ),
      )}
    </>
  );
}

function KeyTextField({
  idPrefix,
  provider,
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  idPrefix: string;
  provider: string;
  field: SignedKeyField;
  value: string;
  error: string | undefined;
  disabled: boolean | undefined;
  onChange: (value: string) => void;
}) {
  const locale = useLocale();
  const id = `${idPrefix}key-${field.key}`;
  const [touched, setTouched] = useState(false);
  const hint = touched
    ? keyFieldHint(provider, field.key, value, locale)
    : null;
  const problem = error ?? hint;
  return (
    <div className="field">
      <label htmlFor={id}>{field.label}</label>
      <input
        id={id}
        type="text"
        value={value}
        placeholder={field.placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-invalid={problem ? true : undefined}
        aria-describedby={`${id}-help`}
        onBlur={() => setTouched(true)}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="help" id={`${id}-help`}>
        {field.description}
      </p>
      {problem ? (
        <p className="field-error" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The private key: a file picker that reads the file in the browser, or a
 * paste box. The key text is held only in the form state and is never
 * rendered back once chosen.
 */
function KeyFileField({
  field,
  value,
  error,
  disabled,
  onChange,
  onFileName,
}: {
  field: SignedKeyField;
  value: string;
  error: string | undefined;
  disabled: boolean | undefined;
  onChange: (value: string) => void;
  onFileName: (name: string, previousName: string | null) => void;
}) {
  const locale = useLocale();
  const t = useT("connections.signedKey");
  const id = useId();
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [fileName, setFileName] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const hint = readError ?? privateKeyHint(value, field.maxBytes, locale);
  const problem = error ?? hint;

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // The same file can be chosen again after a change.
    event.target.value = "";
    if (!file) {
      return;
    }
    setReadError(null);
    if (file.size > field.maxBytes) {
      setFileName(null);
      onChange("");
      setReadError(
        t("fileTooLarge", {
          file: file.name,
          kib: Math.round(field.maxBytes / 1024),
        }),
      );
      return;
    }
    try {
      const text = await file.text();
      setFileName(file.name);
      onChange(text);
      onFileName(file.name, fileName);
    } catch {
      setFileName(null);
      onChange("");
      setReadError(t("fileUnreadable", { file: file.name }));
    }
  }

  function switchTo(next: "file" | "paste") {
    setMode(next);
    setFileName(null);
    setReadError(null);
    onChange("");
  }

  return (
    <div className="field key-file">
      <label htmlFor={id}>{field.label}</label>
      {mode === "file" ? (
        <>
          <div className="key-file-row">
            {/* The native picker would still say "no file chosen" after
                the file is read, so a styled label opens it instead. */}
            <input
              id={id}
              className="visually-hidden"
              type="file"
              accept=".p8,.pem,.txt,application/x-pem-file"
              disabled={disabled}
              aria-invalid={problem ? true : undefined}
              aria-describedby={`${id}-help`}
              onChange={onFile}
            />
            <label
              htmlFor={id}
              className={`file-button${disabled ? " disabled" : ""}`}
            >
              {fileName && value !== ""
                ? t("chooseAnotherFile")
                : t("chooseFile")}
            </label>
            {fileName && value !== "" ? (
              <span className="key-file-loaded" role="status">
                ✓{" "}
                {t("fileRead", {
                  file: fileName,
                  bytes: new TextEncoder().encode(value).length,
                })}
              </span>
            ) : null}
          </div>
          <p className="help" id={`${id}-help`}>
            {field.description}{" "}
            <button
              type="button"
              className="link-button"
              disabled={disabled}
              onClick={() => switchTo("paste")}
            >
              {t("pasteInstead")}
            </button>
          </p>
        </>
      ) : (
        <>
          <textarea
            id={id}
            className="key-paste"
            rows={6}
            value={value}
            placeholder={PEM_PLACEHOLDER}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${id}-help`}
            onChange={(event) => onChange(event.target.value)}
          />
          <p className="help" id={`${id}-help`}>
            {t("pasteHelp")}{" "}
            <button
              type="button"
              className="link-button"
              disabled={disabled}
              onClick={() => switchTo("file")}
            >
              {t("fileInstead")}
            </button>
          </p>
        </>
      )}
      {problem ? (
        <p className="field-error" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
