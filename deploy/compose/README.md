# Self-hosting netrics with Docker Compose

This runs the signed release images, built from the same commits as the hosted
service (ADR 0013): web, api, worker, scheduler, PostgreSQL and Caddy (automatic HTTPS). Every product feature is included; no
license key is needed.

## Requirements

- A Linux host with Docker Engine and the Compose plugin, on `linux/amd64`
  or `linux/arm64` (for example Hetzner CAX or a Raspberry Pi 4/5 with a
  64-bit OS).
- A DNS name pointing at the host, with ports 80 and 443 reachable. Caddy
  obtains a Let's Encrypt certificate automatically.
- `openssl` (used by the installer to generate secrets).

## Install

Pick a release from the
[releases page](https://github.com/netrics-so/netrics/releases) and check out
its tag:

```sh
git clone --branch v0.1.0 https://github.com/netrics-so/netrics.git
cd netrics/deploy/compose
./install.sh --domain netrics.example.com
docker compose up -d
```

`install.sh` writes `.env` with mode 600. It pins the image version to the
checked-out release (tag `v0.1.0` gives `NETRICS_VERSION=0.1.0`) and
generates every secret:

- database password
- the two application role passwords
- session secret
- credential encryption key
- one-time setup token

Then open `https://netrics.example.com/setup` and enter the setup token the
installer printed. That creates the owner account, which is also the
instance administrator. Sign-up stays closed after that: people join through
invitations.

**Back up `.env` right away** (password manager or offline).
`APP_ENCRYPTION_KEY` protects every stored connection credential and cannot
be recovered.

### Email

Invitations and password resets need SMTP. Without it, invitation links are
shown to the inviting admin to hand over, and password reset is unavailable.
Add to `.env`, then run `docker compose up -d`:

```sh
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM=netrics <no-reply@netrics.example.com>
```

### Google connectors

Connectors that sign in with Google (Search Console) need a Google OAuth app
registered for this instance, in a Google Cloud project of its own. Without
one they are listed as unavailable. [Google OAuth app](google-oauth.md)
walks through it: project, Search Console API, consent screen, client,
testing versus publishing, and troubleshooting. In short, register the
redirect URI `<NETRICS_PUBLIC_URL>/oauth/google/callback`, then add both
values to `.env` and run `docker compose up -d`:

```sh
NETRICS_OAUTH_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
NETRICS_OAUTH_GOOGLE_CLIENT_SECRET=...
```

Set both or neither; the API refuses to start with only one. Its startup log
(`oauth providers configured`) names the configured providers and their
redirect URIs. While the app is External and in Testing, Google expires
refresh tokens after 7 days; publish it or use an Internal app.

### Web app and API on separate hosts

Not needed for this install: here the web app reaches the API over the
Compose network, and the API trusts that hop's forwarded client address.
If you run the web app somewhere the API sees as a public address (another
host or platform), the API would see that address for every visitor, and its
sign-in and pairing rate limits would apply to everyone together. Set the
same `NETRICS_PROXY_SECRET` on both (32 characters or more, for example
`openssl rand -base64 32`):

```sh
NETRICS_PROXY_SECRET=...
```

The web app then marks its requests with the secret, and the API believes the
client address they carry. Requests without the secret are still served and
authenticated by session or token, but the API accepts session cookies only
on requests carrying it (browsers always come through the web app), and it
answers 404 to `/api/auth/*` without it. Keep `NETRICS_PUBLIC_URL` (which
sets `BETTER_AUTH_URL` and `WEB_ORIGIN`) on the web app's address. To
rotate, set `new,old` on the API, then `new` on the web app, then `new` on
the API.

The same setup gives token clients (service accounts, `Authorization:
Bearer nt_…`) their own API host, as netrics cloud does with
`https://api.netrics.so`: point a DNS record at the API's published port
(behind TLS) and call `https://<api host>/v1/…`. Without one, token clients
use `<NETRICS_PUBLIC_URL>/v1/…` through the web app.

### Exchange rates (display currency)

Amounts in several currencies (App Store proceeds, Apple Ads) are shown per
currency by default. A workspace or a tile can instead convert them into one
display currency, approximately, with the
[ECB euro reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)
of each day. For that, the `scheduler` fetches
`https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml` every six
hours (the 90-day file once to backfill), through the same guarded egress as
connectors. This is on by default (`NETRICS_EXCHANGE_RATES=ecb`).

To run without it, for example offline, set `NETRICS_EXCHANGE_RATES=off` in
`.env` (it applies to the `api` and the `scheduler`): no request goes to the
ECB, the option is hidden, and tiles show amounts per currency. Stored rates
are kept; turning it back on resumes the daily fetch.

### Language

netrics speaks English and German. Each person picks a language under
Account, and each workspace a language for its TVs and kiosks. For people
and workspaces that have not chosen one, `NETRICS_DEFAULT_LOCALE=de` in
`.env` makes German the default (unset: English; it applies to the `api`
and the `web` app).

### Image quota

Dashboards can show uploaded images (PNG, JPEG or WebP, at most 1 MiB and
4096 px per side). They are stored in PostgreSQL, so backups include them.
Each workspace may keep 100 images and 50 MiB by default. To change that,
set `NETRICS_IMAGE_QUOTA_COUNT` and `NETRICS_IMAGE_QUOTA_MIB` in `.env` and
restart the `api`. Images above a lowered quota stay; only new uploads are
refused.

### Another port

If the host already serves 443, install with `--https-port 8443`. This sets
`NETRICS_HTTPS_PORT` and `NETRICS_PUBLIC_URL`. If port 80 is taken as well,
set `NETRICS_HTTP_PORT`. A certificate for a public domain then needs
Caddy's DNS challenge or your own proxy in front.

## What runs

| Service     | Role                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `postgres`  | The only stateful dependency (volume `pgdata`), not published                                       |
| `migrate`   | Runs on every `up`: migrations, role passwords, connector catalog, then exits                       |
| `api`       | REST API as the RLS-enforced `netrics_app` role; refuses privileged database roles                  |
| `worker`    | Connector syncs                                                                                     |
| `scheduler` | Plans due syncs; fetches ECB exchange rates unless `NETRICS_EXCHANGE_RATES=off`                     |
| `web`       | Web app; proxies the API                                                                            |
| `caddy`     | HTTPS termination; the only published ports                                                         |
| `backup`    | Optional nightly `pg_dump` into `./backups`, 14 days kept (`docker compose --profile backup up -d`) |

## Upgrade

1. Read the release notes of every release in between.
2. Back up (see below).
3. Check out the new release so `compose.yml` matches it:
   `git fetch --tags && git checkout v0.2.0`.
4. Set `NETRICS_VERSION` in `.env` to the new release (`0.2.0`).
5. Run `docker compose pull && docker compose up -d`.

Versions are image tags: `0.2.0` never changes, and `0.2` follows the newest
`0.2.x` patch. Pin the full version and upgrade deliberately. Only the newest
minor release gets fixes while netrics is pre-1.0.

`migrate` runs first and the app services start only after it succeeds. If
a migration fails, the old containers keep running. Migrations only move
forward; to roll back, restore the backup taken before the upgrade and set
the previous `NETRICS_VERSION`.

## Backup and restore

With the backup profile running, dumps land in `./backups`. For a manual
dump:

```sh
docker compose exec -T postgres pg_dump -U netrics -d netrics -Fc > netrics.dump
```

To restore into a fresh installation with the **same `.env`**:

```sh
docker compose up -d postgres
docker compose cp netrics.dump postgres:/tmp/netrics.dump
docker compose exec postgres pg_restore -U netrics -d netrics --clean --if-exists /tmp/netrics.dump
docker compose up -d
```

A dump without its `.env` restores everything except stored connection
credentials, which need `APP_ENCRYPTION_KEY`.

## Verifying images

The images are signed and carry an SPDX SBOM attestation, made by the
release workflow on `main`. Check an image with
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/):

```sh
cosign verify-attestation --type spdxjson \
  --certificate-identity https://github.com/netrics-so/netrics/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/netrics-so/server:0.1.0 > /dev/null && echo verified
```

## Operations

- Logs: `docker compose logs -f api worker scheduler`
- Service tokens for automation or an admin console:
  `docker compose run --rm migrate node dist/admin-cli.js create-service-token --name ops --scope installation:workspaces:read`
- Rotating the encryption key: see the main README, "Rotating the encryption
  key". Run `reencrypt-credentials` the same way.
- Reading a connection's whole history again (for example after an upgrade
  whose release notes say a connector now writes values it skipped before):
  `docker compose run --rm migrate node dist/admin-cli.js backfill-connection --workspace <workspace id> --connection <connection id>`.
  Both ids are in the connection's URL in the web app. Stored values stay
  until the backfill overwrites them.
