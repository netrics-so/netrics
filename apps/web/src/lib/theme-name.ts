// Names for copies of a built-in theme (#216); names are unique per
// workspace regardless of case.

/** "Copy of Paper", or "Copy of Paper 2" when that name is taken. */
export function copyName(baseName: string, takenNames: string[]): string {
  const taken = new Set(takenNames.map((name) => name.toLowerCase()));
  const first = `Copy of ${baseName}`;
  if (!taken.has(first.toLowerCase())) {
    return first;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${first} ${n}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}
