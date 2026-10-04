# 0016 — Internationalisation

Status: proposed (2026-10-04, owner and coordinator decisions; #162,
milestone "i18n (English + German)")

## Context

The owner decided that netrics is multilingual from the beginning: English
is the default, German the second language, and German copy addresses the
reader with the informal "du". The marketing site (netrics.so, in a private
repository) uses `/en` and `/de` paths. This repository has to follow with
the web app, the emails, the screens (browser kiosk and tvOS) and connector
metadata.

Today every user-facing string is English and hard-coded:

- `apps/web` (Next 16 app router, server components, `proxy.ts`): about 190
  source files with JSX text, `aria-label`s, placeholders and error texts
  (`apiErrorMessage` maps API error codes to English sentences).
  `lib/format-metric.ts` formats numbers with a fixed `en-US`, the kiosk and
  TV clocks use `en-GB`; `PERIOD_LABELS` and `COMPARISON_LABELS` are English
  constants, `relative-time.ts` builds "5 minutes ago" by hand.
- `apps/server/src/mail/mailer.ts`: three plain-text emails (verification,
  password reset, invitation), English.
- The device payload (`GET /v1/device/dashboard`, ADR 0015 section 7) carries
  finished labels: the metric name from the connector manifest, the scope
  "All apps" (`allResourcesName` in `@netrics/domain`, built from the
  manifest's `resourceNoun`) and the bar widget's "Others". Period and
  comparison labels are built by each client (`format-metric.ts`,
  `Formatting.swift`).
- `apps/tvos`: SwiftUI `Text("…")` literals, no String Catalog yet.
- Connector manifests (`@netrics/connector-sdk`): `name`, `description`,
  metric `name`/`description` and `resourceNoun` in English only. The
  manifest is stored as `jsonb` in the catalog.

Rules that constrain the choice:

- **One source, same commit** (ADR 0013): nothing environment-specific at
  build time. The instance default language is configuration, read at
  request time.
- **Pin dependencies exactly and avoid young releases**; prefer none.
- **Packages depend inward** (`PACKAGE_LAYERS`): `@netrics/domain` imports
  nothing.
- App URLs are shared inside a workspace (a dashboard link pasted into a
  chat), so two members with different languages must be able to open the
  same URL.

## Decision

### 1. Locales

Supported locales are `en` and `de`, as language tags without region. The
list lives in one place (`SUPPORTED_LOCALES` in `@netrics/domain`), and
adding a language means a new catalog file and a new entry there; no
migration (columns are not constrained to the list, see section 7).

Formatting uses the locale itself with `Intl` (`en` → `en`, `de` → `de`);
regional variants (`de-CH` number grouping, `en-GB` dates) are out of scope
until someone asks.

German copy uses "du" (lower case), sentence case like the English copy,
and keeps product nouns German users know from other tools. Starting
glossary, extended by each area issue in a comment at the top of
`apps/web/src/messages/de.ts`: Workspace, Dashboard, Widget, Studio, Connector
stay; connection → Verbindung, slide → Folie, screen/TV → Bildschirm/TV,
sign in → anmelden, settings → Einstellungen, owner/admin/member →
Inhaber/Admin/Mitglied.

### 2. No locale in app URLs

App URLs carry no locale prefix (`/workspaces/…`, not `/de/workspaces/…`).
The language is a property of the viewer, not of the link, so a shared
dashboard link opens in each member's own language. `proxy.ts` does no
locale routing. The marketing site's `/en` and `/de` paths are unaffected
(different repository and host).

### 3. Which language applies

One function, `resolveLocale`, in `@netrics/domain`, takes the candidates in
order and returns the first supported one:

| Surface                                  | Order                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| Web, signed in                           | user setting → instance default → `Accept-Language` → `en`                    |
| Web, signed out (login, sign-up, reset)  | instance default → `Accept-Language` → `en`                                   |
| Browser kiosk, tvOS (device credentials) | workspace screen language → instance default → `en`                           |
| Emails to a user                         | recipient's setting → instance default → `en`                                 |
| Invitation email (recipient has no user) | recipient's setting if the address has an account → inviter's language → `en` |
| The web TV layout of a signed-in member  | as "web, signed in" (it is the member's browser)                              |

- **User setting**: `users.locale`, nullable. Sign-up stores the language
  the sign-up page was shown in (that is, the instance default, else
  `Accept-Language`), so a new account keeps the language it signed up in.
  Accounts created before this change have `null` and follow the rest of
  the chain until the user picks a language under Account.
- **Workspace screen language**: `workspaces.screen_locale`, nullable; set
  under workspace settings by owners and admins. Screens have no person in
  front of them, so they cannot use a user setting; the workspace that owns
  the device decides. A per-device override is possible later and not
  needed now. Null follows the instance default.
- **Instance default**: `NETRICS_DEFAULT_LOCALE` (`en` or `de`, unset =
  `en`), read at request time by the API and the web app. Compose passes the
  one `.env` value to both; the hosted service leaves it unset. An
  unsupported value is a startup error on the API (`env.ts`) and ignored
  with a warning by the web app, which must render even when misconfigured.
- `Accept-Language` is matched by language with q-values honoured (`de-AT`
  → `de`); a tiny hand-written parser, no dependency.

The web app learns the user's setting from `GET /v1/me`, which gains
`user.locale` (nullable); the root layout reads it once per request through
a React `cache()`d helper that the nav also uses (so no request is added
where a page already calls `getMe`). The setting changes with
`PATCH /v1/me` `{ locale }`. New response fields default to `null` when absent, so a web app deployed before its API (Vercel and Railway roll out separately) still parses the answer. The device payload gains a top-level
`locale` (additive, schema 2 stays 2) so the kiosk and tvOS know which
language the server labelled the payload in and format numbers and their
own chrome to match.

### 4. Mechanism: a small typed catalog, no library

netrics uses an in-house message catalog with a subset of ICU
MessageFormat, not `next-intl` or FormatJS.

- **Format.** ICU MessageFormat syntax, limited to what the UI needs:
  `{name}` arguments, `{count, plural, =0 {…} one {# app} other {# apps}}`
  with `Intl.PluralRules` and `#` formatted by `Intl.NumberFormat` in the
  locale, and `{kind, select, a {…} other {…}}`. No nested rich text
  markup: a component that needs a link inside a sentence uses two keys
  or a `{link}` argument it fills with a React node (`t.rich` takes
  `Record<string, ReactNode>`). Dates, times and numbers are formatted by
  the caller with `Intl` and passed as strings; there are no
  `{d, date}` arguments. Any message valid under this subset is valid ICU,
  so moving to FormatJS later is a swap of the formatter, not of the
  catalogs.
- **Where strings live.**
  - `packages/domain/src/i18n/`: the formatter (~150 lines, pure),
    `SUPPORTED_LOCALES`, `resolveLocale`, `parseAcceptLanguage`, and the
    **shared catalog** for words the server and the clients both produce:
    the scope ("All {plural}"), "Others", period and comparison labels,
    aggregation names. The domain functions that build labels take a
    `locale` argument (`allResourcesName(noun, count, locale)`,
    `tileLabel(…, locale)`) and look up the shared catalog themselves;
    they do not return keys, so every caller gets the finished label the
    way it does today.
  - `apps/web/src/messages/{en,de}.ts`: the web UI, nested by area
    (`nav.*`, `account.*`, `workspaceSettings.*`, `studio.*`, …).
  - `apps/server/src/mail/messages/{en,de}.ts`: email subjects and bodies.
  - tvOS: an Xcode String Catalog (`Localizable.xcstrings`) for the app's
    own text; see section 6.
- **Typed keys.** Catalogs are TypeScript modules, not JSON: `en.ts` is the
  source (`as const`), and `de.ts` is declared as `Catalog<typeof en>`, so
  a key missing in German, or one German has and English does not, is a
  type error. `t("account.language.label")` only accepts existing keys
  (template-literal path type). If translators later want JSON or XLIFF, a
  script can export and import the same tree.
- **Server components** call `const t = await getT("account")` (the
  request's locale from section 3, `cache()`d). **Client components** call
  `useT("account")` from an `I18nProvider` that the root layout fills with
  the locale and the web catalog for that locale. The catalog is small
  (tens of kilobytes for the whole app, both languages are never sent
  together); if it grows, the provider can be filled per route segment
  with the namespaces it uses.
- `<html lang>` follows the locale. Page titles (`metadata`) use
  `generateMetadata` with the translator.

**Why not `next-intl`.** It is the usual choice for Next and would work
without locale routing. But it brings what netrics does not need and
cannot keep simple: 4.14.9 (the current release, 2 days old on
2026-10-04) depends on `@swc/core`, `@parcel/watcher` (native binaries),
`negotiator`, `@formatjs/intl-localematcher`, `icu-minify` and a message
extractor; its value is routing, middleware and extraction, and netrics
uses none of them (no locale in URLs, catalogs typed by hand). The emails
and device labels are rendered by the Fastify API and by
`@netrics/domain`, which would need FormatJS anyway or a second mechanism.
**Why not FormatJS (`intl-messageformat` 12.1.2) alone.** It is a fine
formatter, but the full ICU grammar (nested selects, date skeletons, rich
tags) is more than the UI uses, and `@netrics/domain` must not depend on
anything. The subset is small enough to own and test against the ICU
behaviour it copies. Revisit when a third language with complex plural
rules (Polish, Arabic) is added: `Intl.PluralRules` already handles their
categories, so the formatter should hold, but the decision is cheap to
reverse because the catalogs are ICU.

### 5. Server-side text

- **Emails** render subject and body from `mail/messages` in the
  recipient's language (section 3). The `Mailer` interface gains `locale`
  on every email; better-auth's `sendResetPassword` and
  `sendVerificationEmail` callbacks look up the domain user by auth user id
  to find it. Links stay the same; dates in emails ("expires in 7 days")
  are plural messages.
- **Device payload labels** are built in the workspace's screen language:
  metric names and the resource noun from the connector translations
  (section 6), "All {plural}" and "Others" from the shared catalog.
  Resource names (app names, site URLs) are data and never translated.
  The payload `version` (ETag) hashes the labels, so changing the screen
  language makes every screen fetch the new payload; no extra mechanism.
- **Content created from templates** (the "Overview" dashboard,
  built-in theme names shown in pickers) is created in the creator's
  language and is then the workspace's data, not translated afterwards.
  Built-in theme names are shown through the catalog by their stable key.
- **API errors** stay codes (`{ error: "last_owner" }`); the web app
  translates codes. API responses never contain prose meant for users,
  except data the users wrote.
- Logs, audit events and admin CLI output stay English.

### 6. Connectors and tvOS

**Connector metadata.** The manifest gains an optional `translations` map
(SDK 0.2.6, additive, `^0.2.0` connectors keep loading):

```ts
translations?: Record<
  string, // locale, e.g. "de"
  {
    name?: string;
    description?: string;
    resourceNoun?: { singular: string; plural: string };
    metrics?: Record<string, { name?: string; description?: string }>; // by metric key
  }
>;
```

Translations live with the connector (the people who know the metric's
meaning write them, community connectors ship their own), travel in the
stored `jsonb` manifest without a schema change, and fall back field by
field to the English manifest values. A helper in `@netrics/domain`
(`localizedManifest(manifest, locale)`) does the fallback for both the API
(catalog responses, payload labels) and the web app. The schema rejects
metric keys under `translations` that are not in `metrics`, and the
first-party connectors get German translations in the same issue. Units
are not translated (they are formatted by `Intl`).

**tvOS.** The app's own text (pairing, settings, "Paused", "Connection
stopped", empty and error states, period and comparison labels in
`Formatting.swift`) moves to `Localizable.xcstrings` with `en` and `de`.
Before pairing, the app follows the Apple TV's system language; once
paired, it uses the payload's `locale` for its chrome and number
formatting (`Locale(identifier:)` into the environment and
`String(localized:locale:)`), so the TV matches the kiosk and the
workspace setting. Labels from the payload are shown as they arrive.

### 7. Schema (migration 0036)

```sql
ALTER TABLE users ADD COLUMN locale text;
ALTER TABLE users ADD CONSTRAINT users_locale_format
  CHECK (locale IS NULL OR locale ~ '^[a-z]{2,3}$');
ALTER TABLE workspaces ADD COLUMN screen_locale text;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_screen_locale_format
  CHECK (screen_locale IS NULL OR screen_locale ~ '^[a-z]{2,3}$');
```

Both nullable, no default, so existing rows keep today's behaviour
(English unless the instance default says otherwise) and the migration is
instant. The check only guards the shape; the API validates against
`SUPPORTED_LOCALES`, so adding a language needs no migration, and a
removed language falls back through the chain instead of breaking rows.
`users` is installation-level (no RLS); a user may change only their own
row through `PATCH /v1/me`. `screen_locale` is written through the
existing workspace update path under RLS with the `workspace_id`
predicate, audited like the time zone (`workspace.screen_locale_changed`).

### 8. Formatting

All number, currency, percent, date and relative-time formatting goes
through `Intl` with the resolved locale: `format-metric.ts` loses its
`LOCALE = "en-US"` constant and takes the locale; the kiosk and TV clocks
use the screen language; `relative-time.ts` becomes
`Intl.RelativeTimeFormat`. Time zones stay what they are (workspace
setting); language and time zone are independent.

### 9. Guard against new hard-coded strings

- **Parity test** (`vitest`): for every catalog (shared, web, mail), `de`
  has exactly the keys of `en`, every message parses under the subset, and
  each German message uses the same argument names as the English one.
  Types already catch missing keys; the test catches argument drift and
  syntax errors.
- **Lint rule**: in `apps/web/src`, `no-restricted-syntax` forbids
  `JSXText` containing letters and string literals in the attributes
  `aria-label`, `title`, `placeholder`, `alt` and `label`. It is enabled
  per directory as areas are translated (a list in `eslint.config.mjs`)
  and for all of `apps/web/src` with the last area; tests, `*.test.tsx`,
  the brand name "netrics" and punctuation-only text are allowed. No new
  ESLint plugin is needed.
- **Formatting check**: a lint rule against `"en-US"`/`"en-GB"` literals
  passed to `Intl` constructors in `apps/web/src` once section 8 is done.
- The tvOS String Catalog marks untranslated entries itself; the issue for
  tvOS adds a test that the catalog has a German value for every key.

### 10. Rollout

1. This ADR, milestone "i18n (English + German)" and its issues; #162 is
   the umbrella.
2. Foundation: the catalog mechanism, `resolveLocale`, migration 0036,
   `PATCH /v1/me`, the workspace screen language, the instance default, the
   language setting under Account and the screen language under workspace
   settings, and the nav and Account page in German as proof.
3. Web areas, one issue each, in any order: auth and onboarding;
   workspace, connections and devices; dashboards and studio; settings and
   admin. Each turns on the lint rule for its directories.
4. Emails; device payload, kiosk and tvOS; connector translations (SDK
   0.2.6) — independent of the web areas.
5. The lint rule for all of `apps/web/src`, the `Intl` locale lint, and the
   acceptance check of #162: switching to German translates every screen,
   email and tile label.

Until step 5, German users see English in areas not yet translated; that
is acceptable because the language setting is new and nothing regresses
for English users.

## Alternatives considered

- **Locale prefix in app URLs** (`/de/workspaces/…`, next-intl routing).
  Shared links would carry the sender's language; the proxy would redirect
  every unprefixed link. Rejected; the marketing site has prefixes because
  it is public and indexed, the app is neither.
- **A cookie as the source of the user's language.** Fast, but it differs
  per browser and is lost on a new device; the account setting is the
  source, and the API is asked once per request anyway.
- **Screen language from the assigning user.** The TV would change
  language when another member reassigns the dashboard. Rejected for a
  workspace setting.
- **Domain functions returning message keys** instead of text. Every
  caller (API, web, two client renderers) would need the catalog and the
  argument plumbing; the domain already owns the shared words, so it
  renders them for a given locale.
- **Connector translations in the netrics web catalog.** Community
  connectors could not ship their own, and a new metric would need a
  netrics release to be translated. Rejected.
- **JSON catalogs.** Friendlier to translation tools, but key parity would
  only be checked by a test; TypeScript modules catch it while typing, and
  JSON can be generated when a tool is needed.
- **`next-intl`, FormatJS** — see section 4.

## Consequences

- Every new user-facing string needs an English and a German entry; the
  type checker and the lint rule enforce it. Reviews check the "du" tone
  and the glossary.
- `GET /v1/me`, `PATCH /v1/me`, the workspace update and the device
  payload gain additive fields; `openapi.json` changes.
- The device payload hash changes once for every workspace when labels are
  first built through the catalog (same English text, so screens only
  refetch).
- SDK 0.2.6; connector authors may add `translations`, nothing else
  changes for them.
- The tvOS app needs a release with the String Catalog before TVs show
  German chrome; payload labels are German as soon as the server is.
