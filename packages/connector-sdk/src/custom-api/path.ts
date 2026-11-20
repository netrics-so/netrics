// Dotted data paths for custom API definitions (`data`, `meta.next`,
// `items[0].url`, `data["first name"]`). Not JSONPath: no wildcards, filters
// or expressions. Hand-written scanner; errors never echo the input.

export type DataPathSegment = { key: string } | { index: number };

export class DataPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataPathError";
  }
}

export const DATA_PATH_MAX_SEGMENTS = 32;
/** Longest path accepted, in UTF-16 code units. */
export const DATA_PATH_MAX_LENGTH = 500;
const INDEX_MAX = 1_000_000_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isNameChar(char: string): boolean {
  return /^[A-Za-z0-9_$-]$/.test(char);
}

function checkKey(key: string, position: number): string {
  if (FORBIDDEN_KEYS.has(key))
    throw new DataPathError(`Reserved key in data path at ${position}`);
  return key;
}

/**
 * "" → [] (the root). Grammar: segment ("." segment)*, where a segment is a
 * name followed by any number of `[index]` or `["quoted key"]` suffixes, and a
 * path may also start with such a suffix. Names use [A-Za-z0-9_$-]; quoted
 * keys escape `"` and `\` with a backslash.
 */
export function parseDataPath(path: string): DataPathSegment[] {
  if (path.length > DATA_PATH_MAX_LENGTH)
    throw new DataPathError("Data path is too long");
  const segments: DataPathSegment[] = [];
  const push = (segment: DataPathSegment) => {
    if (segments.length >= DATA_PATH_MAX_SEGMENTS)
      throw new DataPathError("Data path has too many segments");
    segments.push(segment);
  };
  let i = 0;
  const readName = () => {
    const start = i;
    while (i < path.length && isNameChar(path[i]!)) i++;
    if (i === start) throw new DataPathError(`Expected a name at ${start}`);
    push({ key: checkKey(path.slice(start, i), start) });
  };
  const readBracket = () => {
    const open = i;
    i++; // "["
    if (path[i] === '"') {
      i++;
      let key = "";
      for (;;) {
        if (i >= path.length)
          throw new DataPathError(`Unterminated quoted key at ${open}`);
        const char = path[i]!;
        if (char === "\\") {
          const next = path[i + 1];
          if (next !== '"' && next !== "\\")
            throw new DataPathError(`Invalid escape at ${i}`);
          key += next;
          i += 2;
        } else if (char === '"') {
          i++;
          break;
        } else {
          key += char;
          i++;
        }
      }
      if (path[i] !== "]") throw new DataPathError(`Expected "]" at ${i}`);
      i++;
      push({ key: checkKey(key, open) });
      return;
    }
    const start = i;
    while (i < path.length && path[i]! >= "0" && path[i]! <= "9") i++;
    const digits = path.slice(start, i);
    if (
      digits === "" ||
      (digits.length > 1 && digits.startsWith("0")) ||
      digits.length > 10 ||
      Number(digits) > INDEX_MAX
    )
      throw new DataPathError(`Invalid array index at ${start}`);
    if (path[i] !== "]") throw new DataPathError(`Expected "]" at ${i}`);
    i++;
    push({ index: Number(digits) });
  };

  if (path === "") return segments;
  if (path[0] === "[") readBracket();
  else readName();
  while (i < path.length) {
    const char = path[i];
    if (char === "[") readBracket();
    else if (char === ".") {
      i++;
      readName();
    } else throw new DataPathError(`Unexpected character at ${i}`);
  }
  return segments;
}

/** Canonical form; keys outside [A-Za-z0-9_$-] are quoted: data["first name"][0]. parse(format(x)) equals x. */
export function formatDataPath(segments: readonly DataPathSegment[]): string {
  let out = "";
  for (const segment of segments) {
    if ("index" in segment) out += `[${segment.index}]`;
    else if (segment.key !== "" && [...segment.key].every(isNameChar))
      out += out === "" ? segment.key : `.${segment.key}`;
    else out += `["${segment.key.replace(/[\\"]/g, (c) => `\\${c}`)}"]`;
  }
  return out;
}

/** Own properties only; undefined when absent; never reads __proto__/constructor/prototype. */
export function readDataPath(
  value: unknown,
  segments: readonly DataPathSegment[],
): unknown {
  let current = value;
  for (const segment of segments) {
    if ("index" in segment) {
      if (!Array.isArray(current) || segment.index >= current.length)
        return undefined;
      current = current[segment.index];
    } else {
      if (
        current === null ||
        typeof current !== "object" ||
        Array.isArray(current) ||
        FORBIDDEN_KEYS.has(segment.key) ||
        !Object.hasOwn(current, segment.key)
      )
        return undefined;
      current = (current as Record<string, unknown>)[segment.key];
    }
  }
  return current;
}
