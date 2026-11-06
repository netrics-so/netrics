import {
  createNamespacedTranslator,
  type AtNamespace,
  type Catalog,
  type Locale,
  type MessageKey,
  type Namespace,
  type Translator,
} from "@netrics/domain";

import { de } from "@/messages/de";
import { en, type WebMessages } from "@/messages/en";

export type { WebMessages };
export type WebNamespace = Namespace<WebMessages>;
export type WebTranslator<N extends WebNamespace> = Translator<
  MessageKey<AtNamespace<WebMessages, N>>
>;

/** The web catalogs by locale (ADR 0016). */
export const WEB_CATALOGS: Readonly<Record<Locale, Catalog<WebMessages>>> = {
  en,
  de,
};

/** A translator for one area of the web catalog ("account", "nav", …). */
export function webTranslator<N extends WebNamespace>(
  locale: Locale,
  namespace: N,
  messages: Catalog<WebMessages> = WEB_CATALOGS[locale],
): WebTranslator<N> {
  return createNamespacedTranslator<WebMessages, N>(
    { locale, messages, fallback: en },
    namespace,
  );
}
