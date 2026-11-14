import { dataDe } from "../../apps/web/src/messages/data/de.ts";
import { dataEn } from "../../apps/web/src/messages/data/en.ts";

export type Locale = "en" | "de";

/** The data area's UI text in `locale`, from the web app's own catalogs. */
export function labels(locale: Locale): (typeof dataEn)["data"] {
  return (locale === "de" ? dataDe : dataEn).data as (typeof dataEn)["data"];
}

/** A catalog message with its `{name}` placeholders filled in. */
export function fill(
  message: string,
  values: Record<string, string | number>,
): string {
  return message.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
