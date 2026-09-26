export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(value: string): Semver | null {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

export type RangeOperator = ">=" | "<=" | ">" | "<" | "=";

export interface RangeComparator {
  operator: RangeOperator;
  version: Semver;
}

const COMPARATOR_PATTERN = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/;

function caretUpperBound(base: Semver): Semver {
  if (base.major > 0) {
    return { major: base.major + 1, minor: 0, patch: 0 };
  }
  if (base.minor > 0) {
    return { major: 0, minor: base.minor + 1, patch: 0 };
  }
  return { major: 0, minor: 0, patch: base.patch + 1 };
}

/**
 * Parses the supported range forms: exact ("1.2.3"), caret ("^1.2.3"), and
 * space-separated comparator sets (">=1.2.3 <2.0.0"). Returns null when the
 * range uses anything outside those forms.
 */
export function parseRange(range: string): RangeComparator[] | null {
  const trimmed = range.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith("^")) {
    const base = parseSemver(trimmed.slice(1));
    if (!base) {
      return null;
    }
    return [
      { operator: ">=", version: base },
      { operator: "<", version: caretUpperBound(base) },
    ];
  }
  const comparators: RangeComparator[] = [];
  for (const part of trimmed.split(/\s+/)) {
    const match = COMPARATOR_PATTERN.exec(part);
    if (!match) {
      return null;
    }
    const version = parseSemver(match[2] as string);
    if (!version) {
      return null;
    }
    comparators.push({
      operator: (match[1] ?? "=") as RangeOperator,
      version,
    });
  }
  return comparators;
}

function satisfiesComparator(version: Semver, comparator: RangeComparator) {
  const order = compareSemver(version, comparator.version);
  switch (comparator.operator) {
    case ">=":
      return order >= 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case "<":
      return order < 0;
    case "=":
      return order === 0;
  }
}

export function satisfiesRange(version: string, range: string): boolean {
  const parsedVersion = parseSemver(version);
  const comparators = parseRange(range);
  if (!parsedVersion || !comparators) {
    return false;
  }
  return comparators.every((comparator) =>
    satisfiesComparator(parsedVersion, comparator),
  );
}
