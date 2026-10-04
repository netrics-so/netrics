import { headers } from "next/headers";
import { cache } from "react";

import type { Locale } from "@netrics/domain";

import {
  webTranslator,
  type WebNamespace,
  type WebTranslator,
} from "./catalogs";
import { instanceDefaultLocale, requestLocale } from "./locale";
import { getCurrentMe } from "@/lib/current-user";

/** The current request's language (cached per request). */
export const getLocale = cache(async (): Promise<Locale> => {
  const [me, requestHeaders] = await Promise.all([getCurrentMe(), headers()]);
  return requestLocale({
    userLocale: me?.user.locale,
    instanceDefault: instanceDefaultLocale(),
    acceptLanguage: requestHeaders.get("accept-language"),
  });
});

/** A translator for server components: `const t = await getT("account")`. */
export async function getT<N extends WebNamespace>(
  namespace: N,
): Promise<WebTranslator<N>> {
  return webTranslator(await getLocale(), namespace);
}
