# Google OAuth app for a self-hosted instance

Connectors that sign in with Google (Google Search Console) need a Google
OAuth app registered for your instance. The hosted service uses netrics' own
app; a self-hosted instance uses its own, in a Google Cloud project you
control ([ADR 0012](../../docs/decisions/0012-oauth-authorization-code-platform.md)).
Until it is configured, the connector is listed as unavailable and cannot be
connected.

This takes about 15 minutes and needs:

- a Google account that can create Google Cloud projects (for an
  organisation-owned app, one in your Google Workspace organisation);
- the instance's public URL, `NETRICS_PUBLIC_URL` in `.env` (for example
  `https://netrics.example.com`);
- shell access to the host, to edit `.env` and restart.

Google renames console pages from time to time. The names below are those of
the Google Cloud console in October 2026, where the former "OAuth consent
screen" is called **Google Auth Platform**, with the pages Overview,
Branding, Audience, Clients and Data access.

## 1. Work out the redirect URI

netrics derives the redirect URI from the web app's origin and never takes it
from a request:

```text
<origin of NETRICS_PUBLIC_URL>/oauth/google/callback
```

With `NETRICS_PUBLIC_URL=https://netrics.example.com` that is
`https://netrics.example.com/oauth/google/callback`. With a non-default port
(`--https-port 8443`) the port is part of it:
`https://netrics.example.com:8443/oauth/google/callback`. Any path in
`NETRICS_PUBLIC_URL` is dropped. Outside Docker Compose, the same rule
applies to `WEB_ORIGIN`.

Once the app is configured (step 6) the API prints the exact URI at startup;
compare the two then.

Google only accepts `https` redirect URIs on a domain name (`http` is allowed
for `localhost` only, and raw IP addresses are not). An instance reached only
by IP address cannot use Google connectors.

## 2. Create a Google Cloud project

1. Open the [Google Cloud console](https://console.cloud.google.com/).
2. In the project picker at the top, choose **New project**. Name it, for
   example, "netrics" and choose the organisation or "No organisation".
   For an Internal app (step 3) it must belong to your Google Workspace
   organisation.
3. Select the new project in the project picker.

Use a project of its own for each netrics instance, and do not reuse it for
other applications. Google revokes access per Google account and per Cloud
_project_: when netrics revokes a grant (a user disconnects the account's
last Search Console connection), Google invalidates the tokens of every
OAuth client in that project for that account. Two instances sharing a
project, or an OAuth client, would disconnect each other.

## 3. Enable the Search Console API

1. Go to **APIs & Services** > **Library**.
2. Search for **Google Search Console API** (`searchconsole.googleapis.com`)
   and open it.
3. Choose **Enable**.

Without it, connecting succeeds but listing properties and syncing fail with
a "has not been used in project ... or it is disabled" error.

## 4. Configure the Google Auth Platform

Go to **Google Auth Platform** (in the navigation menu, or search for it).
On a new project, **Overview** shows **Get started**; choose it and fill in:

- **App information**: **App name** (what users see on the consent screen,
  for example "netrics (Example Inc.)") and **User support email**.
- **Audience**:
  - **Internal** if your Google accounts are all in one Google Workspace (or
    Cloud Identity) organisation and the project belongs to it. Only
    accounts of that organisation can connect. There is no testing phase,
    no 7-day token expiry and no Google review. A Search Console property
    owned by an account outside the organisation cannot be connected.
  - **External** otherwise (for example personal `@gmail.com` accounts). The
    app starts in **Testing**; see step 5.
- **Contact information**: one or more email addresses where Google sends
  notices about the project.
- Accept the Google API Services User Data Policy and choose **Create**.

Then:

1. **Branding**: under **Authorized domains**, add the registrable domain of
   your instance: `example.com` for `netrics.example.com`. Optionally fill in
   **App domain** (home page, privacy policy, terms of service links) and a
   logo; step 5 says when they are needed. Save.
2. **Data access**: choose **Add or remove scopes** and select these three,
   then **Update** and **Save**:

   | Scope                                                 | Why                                   |
   | ----------------------------------------------------- | ------------------------------------- |
   | `openid`                                              | Identifies the Google account         |
   | `https://www.googleapis.com/auth/userinfo.email`      | Shows which account a connection uses |
   | `https://www.googleapis.com/auth/webmasters.readonly` | Read-only Search Console access       |

   If `webmasters.readonly` is not in the list, the Search Console API is not
   enabled yet (step 3); you can also paste it under **Manually add scopes**.
   Google lists all three as non-sensitive, so they need no security
   review. netrics asks for exactly these scopes when a user connects; do
   not add others here.

## 5. Testing or in production (External apps only)

An External app starts with the publishing status **Testing**:

- Only the **Test users** listed on the **Audience** page (up to 100) can
  connect. Add the Google account of everyone who will connect Search
  Console with **Add users**. Anyone else gets "Error 403: access_denied".
- Google lets refresh tokens of a Testing app expire after **7 days**. Every
  Search Console connection then stops syncing and shows that it needs
  reauthorization; a user has to choose **Reconnect** each week.
- Consent shows a "Google hasn't verified this app" notice, which test users
  can pass with **Continue**.

That is fine for trying netrics out. For lasting connections either use an
Internal app (step 4), or publish the External app:

1. On **Branding**, fill in **App domain**: the application home page and the
   privacy policy link, both on an authorized domain. Google asks you to
   prove ownership of that domain; verifying it in
   [Search Console](https://search.google.com/search-console) as a domain
   property is enough.
2. On **Audience**, choose **Publish app** and confirm. The status becomes
   **In production**, and any Google account can connect; the test user list
   no longer applies.

Because the app only asks for non-sensitive scopes, publishing needs no
Google verification. **Brand verification** (offered on **Branding** or
**Verification center**) is optional: it lets the consent screen show your
app name and logo instead of only the domain.

Existing connections keep their 7-day tokens after publishing; reconnect
them once.

## 6. Create the OAuth client

1. Go to **Google Auth Platform** > **Clients** and choose **Create client**.
2. **Application type**: **Web application**. **Name**: anything, for
   example "netrics".
3. **Authorized JavaScript origins**: leave empty.
4. **Authorized redirect URIs**: **Add URI** and enter the URI from step 1,
   exactly: same scheme, host and port, no trailing slash.
5. Choose **Create**.

The dialog shows the **Client ID** (ending in `.apps.googleusercontent.com`)
and the **Client secret**. Copy the secret now: Google shows it only once.
If it is lost, open the client, choose **Add secret**, use the new one and
disable the old one.

## 7. Configure netrics

Add both values to `.env` (mode 600; never commit it) without quotes:

```sh
NETRICS_OAUTH_GOOGLE_CLIENT_ID=123456789012-abc123.apps.googleusercontent.com
NETRICS_OAUTH_GOOGLE_CLIENT_SECRET=GOCSPX-...
```

Set both or neither: the API and the worker refuse to start with only one and
name the missing variable. `compose.yml` passes them to the `api` (which runs
the authorization) and the `worker` (which refreshes access tokens). Outside
Docker Compose, set them on both processes.

Apply the change:

```sh
docker compose up -d
```

Compose recreates `api` and `worker` with the new environment.

## 8. Verify

1. The API logs the configured providers and the redirect URI each one
   expects (never the secret):

   ```sh
   docker compose logs api | grep 'oauth providers configured'
   ```

   ```text
   {"level":30,…,"oauthProviders":[{"provider":"google","redirectUri":"https://netrics.example.com/oauth/google/callback"}],"msg":"oauth providers configured"}
   ```

   The `redirectUri` must match the URI registered on the client
   character for character. An empty list (`"oauthProviders":[]`) means the
   variables did not reach the `api` container: check `.env` and run
   `docker compose up -d` again.

2. In the web app, add a connection in a workspace: Google Search Console is
   listed as available. (Without the variables it is listed as unavailable,
   with a note that an administrator has to configure it.)
3. Connect it with a Google account that has access to a Search Console
   property (a test user while the app is in Testing). After consent you
   return to netrics and choose the property.

The host needs outbound HTTPS to `oauth2.googleapis.com` and
`searchconsole.googleapis.com`; users' browsers need to reach
`accounts.google.com`.

## Troubleshooting

**"Error 400: redirect_uri_mismatch" at Google.** The registered redirect
URI differs from the one netrics sends. Copy `redirectUri` from the log line
(step 8) into **Clients** > your client > **Authorized redirect URIs**.
Common causes: `http` instead of `https`, a missing or extra port, a
trailing slash, `www.` or a changed `NETRICS_PUBLIC_URL`. Changes at Google
can take a few minutes to apply.

**"Error 403: access_denied" or "has not completed the Google verification
process".** The app is External and in Testing, and the account is not a
test user. Add it under **Audience** > **Test users**, or publish the app
(step 5). With an Internal app, the account is outside your organisation.
A user who chooses **Cancel** on the consent screen also ends with
`access_denied`; netrics then reports that access was not granted.

**"Error 401: invalid_client" at Google, or connecting fails after consent
and the API logs `oauth authorization refused` with an `invalid_client`
reason.** The client ID or secret is wrong:
a copy-paste error, quotes or spaces in `.env`, a deleted client, a disabled
secret, or a client from another project. Check both values and run
`docker compose up -d`. "deleted_client" means the client was deleted;
create a new one (step 6).

**Connections need reauthorization every 7 days.** The app is External and
in Testing. Publish it or use an Internal app (step 5), then reconnect each
connection once.

**A connection suddenly needs reauthorization.** Its refresh token was
revoked or expired: the user removed netrics at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions)
(this stops every connection of that Google account on this instance), the
7-day Testing limit, or the token went unused for six months.
Google also keeps at most 100 refresh tokens per Google account per OAuth
client and silently invalidates the oldest; every netrics connection holds
its own, so one account with more than 100 connections on an instance loses
the oldest. In each case **Reconnect** on the connection fixes it.

**"Google hasn't verified this app".** Expected while the app is in Testing
(test users choose **Continue**). For a published app, check that **Data
access** lists only the three scopes above; sensitive scopes would require
Google's verification.

**Disconnecting one connection stopped others.** netrics only revokes at
Google when the deleted connection was the last one of that Google account
on the instance. Connections elsewhere can still stop if another netrics
instance, or another application, uses the same Google Cloud project (step
2). Give each instance its own project.

**Search Console API errors after connecting** ("has not been used in
project", "is disabled"). Enable the API in the project that owns the client
(step 3) and wait a few minutes.

## Changing the domain or rotating the secret

- New domain: add the new redirect URI to the client (keep the old one until
  the switch), update `NETRICS_PUBLIC_URL` and restart. Existing connections
  keep working; their tokens belong to the client, not the URI.
- New secret: on the client, **Add secret**, set it in `.env`, run
  `docker compose up -d`, then disable and delete the old secret. Existing
  connections are unaffected.
- New client or project: existing connections cannot use it; each needs
  **Reconnect**.
