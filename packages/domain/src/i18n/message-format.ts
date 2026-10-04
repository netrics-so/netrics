/**
 * A subset of ICU MessageFormat (ADR 0016 section 4):
 *
 * - `{name}`: an argument; numbers are formatted with Intl.NumberFormat in
 *   the message's locale, everything else with String().
 * - `{count, plural, =0 {none} one {# app} other {# apps}}`: plural
 *   categories from Intl.PluralRules, exact matches `=n`, an optional
 *   `offset:n`; `#` is the (offset) number, formatted in the locale.
 * - `{kind, select, a {…} b {…} other {…}}`.
 * - Apostrophes quote as in ICU's default mode: `''` is one apostrophe, and
 *   `'` starts quoted literal text only before `{`, `}` or (inside a plural)
 *   `#`. Any other apostrophe ("don't") is literal.
 *
 * Every message valid here is valid ICU, so the catalogs move to FormatJS
 * unchanged if this ever stops being enough. Dates, times and rich text
 * markup are deliberately not supported: callers format dates with Intl and
 * pass strings, and fill rich parts through arguments (formatToParts).
 */

export type MessageNode =
  | { type: "text"; value: string }
  | { type: "argument"; name: string }
  | { type: "pound" }
  | {
      type: "plural";
      name: string;
      offset: number;
      options: Readonly<Record<string, readonly MessageNode[]>>;
    }
  | {
      type: "select";
      name: string;
      options: Readonly<Record<string, readonly MessageNode[]>>;
    };

export class MessageSyntaxError extends Error {
  constructor(message: string, source: string) {
    super(`${message} in message ${JSON.stringify(source)}`);
    this.name = "MessageSyntaxError";
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLURAL_SELECTOR = /^(?:=\d+|zero|one|two|few|many|other)$/;
const SELECT_SELECTOR = /^[A-Za-z0-9_-]+$/;

/** Parses a message into nodes; throws MessageSyntaxError. */
export function parseMessage(source: string): MessageNode[] {
  let position = 0;

  const fail = (message: string): never => {
    throw new MessageSyntaxError(`${message} at ${position}`, source);
  };

  const skipSpace = () => {
    while (position < source.length && /\s/.test(source[position]!)) {
      position += 1;
    }
  };

  const readWord = (): string => {
    skipSpace();
    const start = position;
    while (position < source.length && !/[\s,{}]/.test(source[position]!)) {
      position += 1;
    }
    return source.slice(start, position);
  };

  const expect = (char: string) => {
    skipSpace();
    if (source[position] !== char) {
      fail(`expected "${char}"`);
    }
    position += 1;
  };

  // Text and placeables until an unmatched "}" or the end.
  const parseNodes = (inPlural: boolean, depth: number): MessageNode[] => {
    const nodes: MessageNode[] = [];
    let text = "";
    const flush = () => {
      if (text) {
        nodes.push({ type: "text", value: text });
        text = "";
      }
    };
    while (position < source.length) {
      const char = source[position]!;
      if (char === "'") {
        const next = source[position + 1];
        if (next === "'") {
          text += "'";
          position += 2;
          continue;
        }
        if (next === "{" || next === "}" || (inPlural && next === "#")) {
          // Quoted literal text up to the next single apostrophe.
          position += 1;
          while (position < source.length) {
            if (source[position] === "'") {
              if (source[position + 1] === "'") {
                text += "'";
                position += 2;
                continue;
              }
              position += 1;
              break;
            }
            text += source[position];
            position += 1;
          }
          continue;
        }
        text += char;
        position += 1;
        continue;
      }
      if (char === "}") {
        if (depth === 0) {
          fail('unmatched "}"');
        }
        break;
      }
      if (char === "#" && inPlural) {
        flush();
        nodes.push({ type: "pound" });
        position += 1;
        continue;
      }
      if (char === "{") {
        flush();
        position += 1;
        nodes.push(parsePlaceable(depth, inPlural));
        continue;
      }
      text += char;
      position += 1;
    }
    flush();
    return nodes;
  };

  const parseOptions = (
    kind: "plural" | "select",
    depth: number,
    inPlural: boolean,
  ): Record<string, MessageNode[]> => {
    const options: Record<string, MessageNode[]> = {};
    for (;;) {
      skipSpace();
      if (source[position] === "}") {
        break;
      }
      const selector = readWord();
      const valid = kind === "plural" ? PLURAL_SELECTOR : SELECT_SELECTOR;
      if (!valid.test(selector)) {
        fail(`invalid ${kind} selector "${selector}"`);
      }
      if (selector in options) {
        fail(`duplicate selector "${selector}"`);
      }
      expect("{");
      options[selector] = parseNodes(inPlural || kind === "plural", depth + 1);
      expect("}");
    }
    if (!("other" in options)) {
      fail(`${kind} without "other"`);
    }
    return options;
  };

  const parsePlaceable = (depth: number, inPlural: boolean): MessageNode => {
    skipSpace();
    const name = readWord();
    if (!IDENTIFIER.test(name)) {
      fail(`invalid argument name "${name}"`);
    }
    skipSpace();
    if (source[position] === "}") {
      position += 1;
      return { type: "argument", name };
    }
    expect(",");
    const kind = readWord();
    if (kind !== "plural" && kind !== "select") {
      fail(`unsupported argument type "${kind}"`);
    }
    expect(",");
    let offset = 0;
    if (kind === "plural") {
      skipSpace();
      const match = /^offset:\s*(\d+)/.exec(source.slice(position));
      if (match) {
        offset = Number(match[1]);
        position += match[0].length;
      }
    }
    const options = parseOptions(kind as "plural" | "select", depth, inPlural);
    expect("}");
    return kind === "plural"
      ? { type: "plural", name, offset, options }
      : { type: "select", name, options };
  };

  const nodes = parseNodes(false, 0);
  if (position < source.length) {
    fail("unexpected input");
  }
  return nodes;
}

/** The argument names a message uses, sorted (for catalog parity tests). */
export function messageArguments(source: string): string[] {
  const names = new Set<string>();
  const walk = (nodes: readonly MessageNode[]) => {
    for (const node of nodes) {
      if (node.type === "text" || node.type === "pound") {
        continue;
      }
      names.add(node.name);
      if (node.type === "plural" || node.type === "select") {
        Object.values(node.options).forEach(walk);
      }
    }
  };
  walk(parseMessage(source));
  return [...names].sort();
}

export type MessageValues = Readonly<Record<string, unknown>>;

const parsed = new Map<string, MessageNode[]>();
const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function cached<T>(map: Map<string, T>, key: string, make: () => T): T {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
}

/**
 * Formats a message into parts: strings, and argument values that are not
 * strings or numbers left as they are (a React node for a link, say). A
 * missing argument renders as `{name}` so the gap is visible, not silent.
 */
export function formatMessageToParts<T = never>(
  locale: string,
  source: string,
  values: MessageValues = {},
): (string | T)[] {
  const nodes = cached(parsed, source, () => parseMessage(source));
  const parts: (string | T)[] = [];
  const push = (part: string | T) => {
    const last = parts.at(-1);
    if (typeof part === "string" && typeof last === "string") {
      parts[parts.length - 1] = last + part;
    } else {
      parts.push(part);
    }
  };
  const number = (value: number) =>
    cached(numberFormats, locale, () => new Intl.NumberFormat(locale)).format(
      value,
    );

  const render = (list: readonly MessageNode[], pound: number | null) => {
    for (const node of list) {
      switch (node.type) {
        case "text":
          push(node.value);
          break;
        case "pound":
          push(pound === null ? "#" : number(pound));
          break;
        case "argument": {
          const value = values[node.name];
          if (value === undefined || value === null) {
            push(`{${node.name}}`);
          } else if (typeof value === "number") {
            push(number(value));
          } else if (typeof value === "string") {
            push(value);
          } else {
            push(value as T);
          }
          break;
        }
        case "plural": {
          const raw = Number(values[node.name]);
          const value = Number.isFinite(raw) ? raw : 0;
          const exact = node.options[`=${value}`];
          const category = cached(
            pluralRules,
            locale,
            () => new Intl.PluralRules(locale),
          ).select(value - node.offset);
          render(
            exact ?? node.options[category] ?? node.options.other!,
            value - node.offset,
          );
          break;
        }
        case "select": {
          const key = String(values[node.name]);
          render(node.options[key] ?? node.options.other!, pound);
          break;
        }
      }
    }
  };
  render(nodes, null);
  return parts;
}

/** Formats a message to a string (see formatMessageToParts). */
export function formatMessage(
  locale: string,
  source: string,
  values: MessageValues = {},
): string {
  return formatMessageToParts<unknown>(locale, source, values)
    .map((part) => (typeof part === "string" ? part : String(part)))
    .join("");
}
