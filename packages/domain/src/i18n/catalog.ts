import type { Locale } from "./locale.js";
import {
  formatMessage,
  formatMessageToParts,
  messageArguments,
  type MessageValues,
} from "./message-format.js";

/**
 * A message catalog: nested objects whose leaves are ICU messages
 * (ADR 0016 section 4). The English catalog of each app is the source,
 * declared `as const`; every other language is typed `Catalog<typeof en>`,
 * so a missing or extra key is a type error.
 */
export interface Messages {
  readonly [key: string]: string | Messages;
}

/** The shape of a source catalog with every message widened to string. */
export type Catalog<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : Catalog<T[K]>;
};

/** "a.b.c" for every message (leaf) of a catalog. */
export type MessageKey<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${MessageKey<T[K]>}`;
}[keyof T & string];

/** "a" and "a.b" for every group (non-leaf) of a catalog. */
export type Namespace<T> = {
  [K in keyof T & string]: T[K] extends string
    ? never
    : K | `${K}.${Namespace<T[K]>}`;
}[keyof T & string];

/** The group a namespace names. */
export type AtNamespace<
  T,
  N extends string,
> = N extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? AtNamespace<T[Head], Rest>
    : never
  : N extends keyof T
    ? T[N]
    : never;

export interface Translator<Key extends string> {
  readonly locale: Locale;
  (key: Key, values?: MessageValues): string;
  /**
   * The message as parts, keeping argument values that are not strings or
   * numbers (a React element for a link inside a sentence).
   */
  rich<T>(
    key: Key,
    values: Readonly<Record<string, string | number | T>>,
  ): (string | T)[];
  /** Whether the key exists (for keys built at runtime, e.g. error codes). */
  has(key: string): key is Key;
}

function lookup(messages: Messages, path: string): string | undefined {
  let node: string | Messages | undefined = messages;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null) {
      return undefined;
    }
    node = Object.hasOwn(node, part) ? node[part] : undefined;
  }
  return typeof node === "string" ? node : undefined;
}

export interface TranslatorOptions<T> {
  locale: Locale;
  messages: Catalog<T>;
  /** The English catalog, for keys missing at runtime. */
  fallback?: Catalog<T>;
}

function translatorFor(
  options: { locale: Locale; messages: Messages; fallback?: Messages },
  prefix: string,
): Translator<string> {
  const source = (key: string): { locale: string; message: string } => {
    const own = lookup(options.messages, prefix + key);
    if (own !== undefined) {
      return { locale: options.locale, message: own };
    }
    const fallback = options.fallback
      ? lookup(options.fallback, prefix + key)
      : undefined;
    return fallback !== undefined
      ? { locale: "en", message: fallback }
      : { locale: options.locale, message: prefix + key };
  };
  const translate = ((key: string, values?: MessageValues) => {
    const { locale, message } = source(key);
    return formatMessage(locale, message, values);
  }) as Translator<string>;
  Object.defineProperty(translate, "locale", { value: options.locale });
  translate.rich = <R>(
    key: string,
    values: Readonly<Record<string, string | number | R>>,
  ) => {
    const { locale, message } = source(key);
    return formatMessageToParts<R>(locale, message, values);
  };
  translate.has = (key: string): key is string =>
    lookup(options.messages, prefix + key) !== undefined ||
    (options.fallback !== undefined &&
      lookup(options.fallback, prefix + key) !== undefined);
  return translate;
}

/**
 * A translator for one locale. `fallback` (the English catalog) answers
 * keys the locale's catalog lacks at runtime; types prevent that for
 * literal keys, so it only matters for keys built at runtime. A key in
 * neither renders as the key itself.
 */
export function createTranslator<T extends Messages>(
  options: TranslatorOptions<T>,
): Translator<MessageKey<T>> {
  return translatorFor(
    options as { locale: Locale; messages: Messages; fallback?: Messages },
    "",
  ) as Translator<MessageKey<T>>;
}

/** A translator for one group of a catalog: keys are relative to it. */
export function createNamespacedTranslator<
  T extends Messages,
  N extends Namespace<T>,
>(
  options: TranslatorOptions<T>,
  namespace: N,
): Translator<MessageKey<AtNamespace<T, N>>> {
  return translatorFor(
    options as { locale: Locale; messages: Messages; fallback?: Messages },
    `${namespace}.`,
  ) as unknown as Translator<MessageKey<AtNamespace<T, N>>>;
}

/** Every message of a catalog by its dotted key. */
export function flattenCatalog(
  messages: Messages,
  prefix = "",
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      result.set(path, value);
    } else {
      for (const [inner, message] of flattenCatalog(value, path)) {
        result.set(inner, message);
      }
    }
  }
  return result;
}

/**
 * Differences between a translation and its source catalog: keys missing
 * on either side, messages that do not parse, and messages whose argument
 * names differ from the source's. Empty when the translation is complete.
 */
export function compareCatalogs(
  source: Messages,
  translation: Messages,
): string[] {
  const problems: string[] = [];
  const a = flattenCatalog(source);
  const b = flattenCatalog(translation);
  const args = (key: string, message: string): string[] | null => {
    try {
      return messageArguments(message);
    } catch (error) {
      problems.push(`${key}: ${(error as Error).message}`);
      return null;
    }
  };
  for (const [key, message] of a) {
    const sourceArgs = args(key, message);
    const translated = b.get(key);
    if (translated === undefined) {
      problems.push(`${key}: missing in translation`);
      continue;
    }
    const translatedArgs = args(key, translated);
    if (
      sourceArgs &&
      translatedArgs &&
      sourceArgs.join(",") !== translatedArgs.join(",")
    ) {
      problems.push(
        `${key}: arguments {${translatedArgs.join(", ")}} differ from {${sourceArgs.join(", ")}}`,
      );
    }
  }
  for (const key of b.keys()) {
    if (!a.has(key)) {
      problems.push(`${key}: not in the source catalog`);
    }
  }
  return problems;
}
