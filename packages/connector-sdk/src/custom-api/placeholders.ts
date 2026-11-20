// `{{ name }}` placeholders for custom API definitions. A closed set of names
// (connection variables, window bounds, page values); no expressions,
// filters, loops or conditionals. Hand-written scanner.

export const WINDOW_PLACEHOLDERS = ["window.start", "window.end"] as const;
export const PAGE_PLACEHOLDERS = [
  "page.number",
  "page.offset",
  "page.size",
  "page.cursor",
] as const;
export type WindowPlaceholder = (typeof WINDOW_PLACEHOLDERS)[number];
export type PagePlaceholder = (typeof PAGE_PLACEHOLDERS)[number];
export const VARIABLE_ID = /^[a-z][a-z0-9_]{0,39}$/;

const RESERVED = new Set<string>([
  ...WINDOW_PLACEHOLDERS,
  ...PAGE_PLACEHOLDERS,
]);

export interface PlaceholderRef {
  name: string;
  /** Index of the opening "{{". */
  start: number;
  /** Index just past the closing "}}". */
  end: number;
}

export class PlaceholderSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceholderSyntaxError";
  }
}

export function isPlaceholderName(name: string): boolean {
  return RESERVED.has(name) || VARIABLE_ID.test(name);
}

function isBlank(char: string): boolean {
  return char === " " || char === "\t";
}

/** `{{ name }}` (inner whitespace trimmed). A "{{" that does not open a valid placeholder throws. */
export function parsePlaceholders(template: string): PlaceholderRef[] {
  const refs: PlaceholderRef[] = [];
  let i = 0;
  for (;;) {
    const start = template.indexOf("{{", i);
    if (start === -1) return refs;
    const close = template.indexOf("}}", start + 2);
    if (close === -1)
      throw new PlaceholderSyntaxError(`Unclosed placeholder at ${start}`);
    let from = start + 2;
    let to = close;
    while (from < to && isBlank(template[from]!)) from++;
    while (to > from && isBlank(template[to - 1]!)) to--;
    const name = template.slice(from, to);
    // Names are short; a long inner text is never a placeholder and is not echoed.
    if (name.length > 40 || !isPlaceholderName(name))
      throw new PlaceholderSyntaxError(`Invalid placeholder at ${start}`);
    refs.push({ name, start, end: close + 2 });
    i = close + 2;
  }
}

/** Replaces each placeholder with encode(values[name]); throws PlaceholderSyntaxError naming the missing placeholder (not a value). */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
  encode: (value: string) => string,
): string {
  let out = "";
  let last = 0;
  for (const ref of parsePlaceholders(template)) {
    if (!Object.hasOwn(values, ref.name))
      throw new PlaceholderSyntaxError(
        `No value for placeholder {{${ref.name}}}`,
      );
    out += template.slice(last, ref.start) + encode(values[ref.name]!);
    last = ref.end;
  }
  return out + template.slice(last);
}
