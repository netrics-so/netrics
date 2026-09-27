/**
 * Accepts only same-origin relative paths for post-login redirects, so a
 * crafted ?next= cannot send users to another site ("//evil", "https://…").
 */
export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return null;
  }
  return value;
}
