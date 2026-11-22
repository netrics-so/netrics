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

Take the newest release from the
[releases page](https://github.com/netrics-so/netrics/releases/latest) and
check out its tag. Replace `vX.Y.Z` with it, for example `v0.2.0`:

```sh
git clone --branch vX.Y.Z https://github.com/netrics-so/netrics.git
cd netrics/deploy/compose
./install.sh --domain netrics.example.com
docker compose up -d
```

`install.sh` writes `.env` with mode 600. It pins the image version to the
checked-out release (tag `vX.Y.Z` gives `NETRICS_VERSION=X.Y.Z`) and
generates every secret:

- database password
- the two application role passwords
- session secret
- credential encryption key
- one-time setup token

It also names the Compose project `netrics-selfhost` (`COMPOSE_PROJECT_NAME`
in `.env`, see "Project name") and creates `backups/`, readable only by you.

Then open `https://netrics.example.com/setup` and enter the setup token the
installer printed. That creates the owner account, which is also the
instance administrator. Sign-up stays closed after that: people join through
invitations.

**Back up `.env` right away** (password manager or offline).
`APP_ENCRYPTION_KEY` protects every stored connection credential and cannot
be recovered.

### Try it locally

To try netrics on your own machine, without a DNS name, install for
`localhost`:

```sh
./install.sh --domain localhost
docker compose up -d
```

Then open `https://localhost/setup`. Caddy signs the certificate for
`localhost` with its own local certificate authority, which the browser does
not know: it warns once, and you accept the warning to continue. If ports
80 or 443 are taken, add `--http-port 8080 --https-port 8443` and open
`https://localhost:8443/setup`. This is for trying it out; a server needs a
real DNS name. To remove the trial, with its data, run
`docker compose down --volumes` in this folder.

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

All connections of such a connector share the OAuth app's request quota,
across workspaces. The worker therefore loads the history (a backfill) of
at most 4 of a connector's OAuth connections at a time; the others wait
their turn, and regular syncs are not held back. To change the number, set
`WORKER_BACKFILLS_PER_APP` in `.env` (`0` removes the cap) and run
`docker compose up -d`:

```dotenv
WORKER_BACKFILLS_PER_APP=4
```

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

### Preview connectors

Connectors that are not finished yet ship in the images as previews and
stay off: the catalogue does not list them, and nothing can connect or sync
them. There are currently none: every connector in the images is
available without a setting. When a release ships one, name it in
`NETRICS_PREVIEW_CONNECTORS` in `.env` (comma-separated IDs) and run
`docker compose up -d`. It applies to `migrate` (the connector catalog),
the `api` and the `worker`, which log the connectors they registered at
startup. The catalogue then lists the connector with a "Preview" tag: it
works, but its setup, data or dashboards may still change before it is
final. An ID that is no connector of the release (a typo) stops the server
at startup with an error naming it.

Removing an ID from the variable hides the connector again. Its
connections and stored data stay, but their syncs fail (no such connector)
until it is turned back on, so delete those connections first if you are
done with the preview.

Once a preview is finished, a release turns it on for every installation.
An ID in the variable that is no longer a preview is then ignored with a
warning in the log, so upgrading needs no change to `.env`; remove the ID
whenever convenient. Apple Ads was a preview up to v0.3.2: a leftover
`NETRICS_PREVIEW_CONNECTORS=apple-ads` now only logs that warning and can
be removed.

### Image quota

Dashboards can show uploaded images (PNG, JPEG or WebP, at most 1 MiB and
4096 px per side). They are stored in PostgreSQL, so backups include them.
Each workspace may keep 100 images and 50 MiB by default. To change that,
set `NETRICS_IMAGE_QUOTA_COUNT` and `NETRICS_IMAGE_QUOTA_MIB` in `.env` and
restart the `api`. Images above a lowered quota stay; only new uploads are
refused.

After each sync of a custom API with an image field, the worker copies the
images of the newest items (PNG, JPEG or WebP, at most 2 MiB each, metadata
removed) into PostgreSQL too. They have their own quota, 500 images and
200 MiB per workspace by default, and do not count against uploads. To
change it, set `NETRICS_CUSTOM_API_IMAGE_QUOTA_COUNT` and
`NETRICS_CUSTOM_API_IMAGE_QUOTA_MIB` in `.env` and restart the `worker`.
Images beyond the quota are skipped and counted on the connection. Images
no longer among a stream's newest items are deleted after seven days.

### Custom API limits

Each workspace may keep 50 custom API definitions (archived ones don't
count) with at most 20 streams each, and 100 custom API connections; a
custom API connection refreshes at most every 15 minutes. To change that,
set these in `.env` and restart the `api`:

```dotenv
NETRICS_CUSTOM_API_MAX_DEFINITIONS=50
NETRICS_CUSTOM_API_MAX_STREAMS=20
NETRICS_CUSTOM_API_MAX_CONNECTIONS=100
NETRICS_CUSTOM_API_MIN_REFRESH_MINUTES=15
```

`NETRICS_CUSTOM_API_MAX_STREAMS` can't go above 20, and
`NETRICS_CUSTOM_API_MIN_REFRESH_MINUTES` takes 1 to 1440. Existing
definitions above a lowered limit stay; only new ones are refused.

### Custom APIs on your own network

Connectors, custom API definitions included, may only reach public
addresses: a host name that resolves to a private network, this machine or
a cloud metadata service is refused. To let custom APIs reach services on
your own network, list them in `.env` and restart the `api` and `worker`:

```dotenv
NETRICS_CUSTOM_API_PRIVATE_HOSTS=intranet.example,*.corp.example,10.20.0.0/16
```

Entries are host names (`*.corp.example` matches its subdomains), IP
addresses or CIDR ranges (at least `/8` for IPv4 and `/16` for IPv6); `*`,
`0.0.0.0/0` and `::/0` are refused, and an invalid entry stops startup. A
listed host may resolve to any private address, this machine included; a
definition still reaches only the hosts it declares. List exact hosts: the
`api` and `worker` log a warning at startup for broad entries such as
`*.com` or `localhost`. Cloud metadata and link-local addresses
(`169.254.0.0/16`, `fe80::/10` and the like) stay refused even when listed.
The setting is off by default.

If such a service uses a certificate from your own (private) certificate
authority, netrics refuses the connection until it trusts that authority. Put
the authority's certificate (PEM; several may follow each other in one file)
into `certs/` next to `compose.yml`, point `NODE_EXTRA_CA_CERTS` at it in
`.env` and restart the `api` and `worker`:

```dotenv
NODE_EXTRA_CA_CERTS=/etc/netrics/certs/internal-ca.pem
```

`./certs` is mounted read-only at `/etc/netrics/certs` in both; the folder
must be readable and searchable by everyone (`chmod 755 certs`, which
`install.sh` sets; after an upgrade with a strict umask set it yourself) and
the file readable by everyone (`chmod 644`), as the containers do not run as
your user. The public certificate authorities stay trusted; the extra ones
are added to them. A file that is missing or unreadable adds nothing and
only logs a warning (`Ignoring extra certs from ...`) at the first TLS
connection.

### Data volume and retention

`NETRICS_DATA_POLICY` in `.env` configures data storage, retention and execution
budgets for both the API and worker. For example:

```dotenv
NETRICS_DATA_POLICY='{"maxWorkspaceBytes":null,"queryRows":1000000,"queryOperations":50000000}'
```

Storage and source counts have no default quota. Any policy ceiling can be
removed with `null`. Restart the API and worker after changing defaults.
Instance administrators can also set workspace overrides through the
installation API. See [data processing](../../docs/data-processing.md) for
all settings and retention/deletion behavior.

### Another proxy

Caddy is the only proxy in front of the web app here, and the API trusts the
Compose network's forwarded client address; sign-in and pairing rate limits
count per visitor. If another proxy or load balancer sits in front of Caddy,
Caddy sees that proxy as the visitor. Make Caddy trust it, so it keeps the
visitor address the proxy forwards, by adding a global options block at the
top of `Caddyfile` (with the proxy's address or range):

```caddyfile
{
	servers {
		trusted_proxies static 10.0.0.0/8
	}
}
```

Then tell the web app that two proxies forward each request:

```sh
NETRICS_TRUSTED_PROXY_HOPS=2          # the outer proxy plus Caddy
```

Alternatively, if the outer proxy sets one header with the client address
and overwrites any value the client sent, name it instead:
`NETRICS_CLIENT_IP_HEADER=x-real-ip`.

If the Docker network is shared with containers you do not control, limit
which addresses the API believes (default
`loopback,linklocal,uniquelocal`):

```sh
NETRICS_TRUSTED_PROXIES=172.18.0.0/16
```

`NETRICS_AUTH_RATE_LIMIT=off` turns the sign-in and sign-up limits off (on by
default), for example behind a proxy that rate-limits itself.

### Another port

If the host already serves 443, install with `--https-port 8443`. This sets
`NETRICS_HTTPS_PORT` and `NETRICS_PUBLIC_URL`. If port 80 is taken as well,
add `--http-port 8080` (`NETRICS_HTTP_PORT`). A certificate for a public
domain then needs Caddy's DNS challenge or your own proxy in front.

### Project name

Docker Compose names containers and volumes after the project:
`netrics-selfhost-postgres-1`, and the volume `netrics-selfhost_pgdata`
holds the database. `install.sh` sets the project name `netrics-selfhost` in
`.env` (`COMPOSE_PROJECT_NAME`); `--name` picks another. Every `docker
compose` command in this folder reads it from `.env`, so no `-p` is needed.
A second installation on the same host needs its own folder, name and ports,
for example `./install.sh --domain other.example.com --name netrics-other
--http-port 8080 --https-port 8443`.

Installations made with 0.2.0 or older have no `COMPOSE_PROJECT_NAME` in
`.env`. Compose then names the project after the folder, `compose`, and the
database volume is `compose_pgdata`. Keep it that way: do not add
`COMPOSE_PROJECT_NAME` to such an `.env`, because a new name means new,
empty volumes (the data stays in the old ones). `docker volume ls` shows
which volumes you have. `install.sh --force` in such a folder keeps the old
name when it finds the folder's `<name>_pgdata` volume, and warns if
`--name` asks for another.

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

## Which version runs

`https://<your domain>/healthz` reports the web app's `version` and
`commit`; the `migrate` log (`docker compose logs migrate`) and the API's
`/health/live` report the same for the server. A release reports its
version, `0.2.0`. Images of any other `main` commit report the version they
build on plus the commit: `0.2.0+0123456789ab` is a `main` build after
0.2.0, not the release. (Images up to the 0.2.0 release and the `main` builds
after it reported only the version; there the `commit` tells them apart.)

## Upgrade

1. Read the release notes of every release in between.
2. Back up (see below).
3. Check out the new release so `compose.yml` matches it:
   `git fetch --tags && git checkout vX.Y.Z`.
4. Set `NETRICS_VERSION` in `.env` to the new release (`X.Y.Z`).
5. Run `docker compose pull && docker compose up -d`. With nightly backups
   enabled, run `docker compose --profile backup up -d` instead, so the
   backup service is updated too.

Versions are image tags: `0.2.0` never changes, and `0.2` follows the newest
`0.2.x` patch. Pin the full version and upgrade deliberately. Only the newest
minor release gets fixes while netrics is pre-1.0.

Expect a short downtime. `docker compose up -d` replaces the app containers
first; they start once `migrate` has succeeded. Pulling in step 5 before
`up` keeps that window short.

If `migrate` fails, the app services stay stopped (`docker compose ps`
shows them as `Created`); `docker compose logs migrate` says why. Either fix
the cause and run `docker compose up -d` again, or go back: replace the
database with the backup taken before the upgrade, at the previous
`NETRICS_VERSION` (see "Backup and restore"). The schema migrations of an upgrade run in one
transaction, so when one of them failed the database is unchanged and the
previous release starts without the restore. `migrate` also sets role
passwords and syncs the connector catalog after they commit, though, so
skip the restore only when the log shows a schema migration failed. Please
report the failure with the log.

Migrations only move forward. To go back after a successful upgrade, replace
the database with the backup taken before it, at the previous
`NETRICS_VERSION` (see "Backup and restore").

## Backup and restore

With the backup profile running, a dump lands in `./backups` every night.
To take one now:

```sh
docker compose --profile backup run --rm --no-deps -e BACKUP_ONCE=1 backup
```

It dumps the database as it is, also when `migrate` fails; only `postgres`
has to be running. Dumps are named `netrics-<version>-<commit>-<time>.dump`.
`migrate` records the version and commit of the running release in the
database on every start, the backup service reads them when it dumps, and
the dump carries them too.

A dump holds all data of the installation: accounts, workspaces and the
encrypted connection credentials. The backup service keeps `backups/` at
mode 700 and every dump at mode 600, owned by the owner of `backups/`, so
other users on the host cannot read them. Copy them off the host (another
machine or storage only you can read), and keep them apart from `.env`: the
dump and `APP_ENCRYPTION_KEY` together open the stored credentials.

Some storage refuses to change owners or modes, for example NFS with
`root_squash` or SMB shares. The backup is kept there all the same, mode
600 and owned by the container's `root`, and the service logs a warning
(`docker compose logs backup`). Restrict the folder on the host then.

On installations made with 0.2.0 or older, Docker created `backups/` as
`root`, so the dumps belong to `root` too. Give the folder to the user who
runs `docker compose` once, then take a backup as above (it also makes older
dumps mode 600):

```sh
sudo chown -R "$(id -u):$(id -g)" backups
```

**Restore a dump with the release that wrote it**, then upgrade as described
above. A newer schema has tables and columns the dump does not know: they
survive the restore, the restored migration journal is older, and the next
`migrate` fails running those migrations again. To read the release from a
dump that is already in the `postgres` container (see below):

```sh
docker compose exec postgres pg_restore --data-only --table=schema_info -f - /tmp/restore.dump
```

The `netrics_version` row is the version. Set `NETRICS_VERSION` in `.env` to
it, and check out that release as for an upgrade. A version with a commit,
such as `0.2.0+0123456789ab`, means the installation ran a commit of `main`:
set `NETRICS_VERSION` to the full commit of the `netrics_commit` row
instead, and check out that commit. Dumps written by 0.2.0 or a `main` build
after it carry only the version: if their `netrics_commit` row is not that
release's commit (`git rev-list -n 1 v<version>`), the same applies. Dumps
named `netrics-<time>.dump`, without these rows, come from 0.2.0 or older.
Count their migrations:

```sh
docker compose exec postgres pg_restore --data-only --table=__drizzle_migrations -f - /tmp/restore.dump | grep -c '^[0-9]'
```

70 migrations is 0.2.0, 15 is 0.1.0.

### Into a fresh installation

Use the **same `.env`**. Replace `netrics-….dump` with your file:

```sh
docker compose up -d postgres
docker compose cp backups/netrics-….dump postgres:/tmp/restore.dump
# read the release from the dump (above) and set NETRICS_VERSION
docker compose run --rm migrate
docker compose exec postgres pg_restore -U netrics -d netrics --clean --if-exists /tmp/restore.dump
docker compose up -d
```

`migrate` has to run before `pg_restore`. It creates the database roles the
application connects as (`netrics_app`, `netrics_scheduler`). Roles belong to
the PostgreSQL server, not to the database, so a dump does not contain them.
If they are missing, `pg_restore` skips their privileges and row-level
security policies with `role "netrics_app" does not exist` errors.

If you restored without that step, the next `migrate` stops with "The
application roles lack their privileges". It has created the roles by then:
run the `pg_restore` command again, then `docker compose up -d`.

### Replacing the database of an installation

This is also how to go back after an upgrade.

> [!WARNING]
> This deletes the installation's current database. The steps below stop
> the application and then dump the current database as
> `netrics-…-before-restore.dump`. Keep that file until the restored
> installation works.

Copy in the backup you want to go back to, for example the one taken
before an upgrade. That is **not** the `…-before-restore.dump` just written
into the same folder.

```sh
docker compose stop api worker scheduler web caddy backup
docker compose --profile backup run --rm --no-deps -e BACKUP_ONCE=1 -e BACKUP_LABEL=before-restore backup
docker compose cp backups/netrics-<the backup to restore>.dump postgres:/tmp/restore.dump
docker compose exec postgres pg_restore --list /tmp/restore.dump > /dev/null && echo "dump readable"
# read the release from the dump (above) and set NETRICS_VERSION
docker compose exec postgres dropdb -U netrics --force netrics
docker compose exec postgres createdb -U netrics netrics
docker compose exec postgres pg_restore -U netrics -d netrics /tmp/restore.dump
docker compose up -d
```

Go on to `dropdb` only when `pg_restore --list` printed "dump readable".
The roles already exist on this server, so the restore into the empty
database keeps their privileges.

A dump without its `.env` restores everything except stored connection
credentials, which need `APP_ENCRYPTION_KEY`.

## Verifying images

The images are signed and carry an SPDX SBOM attestation, made by the
release workflow on `main`. Check an image with
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 3 or
later (cosign 2 needs `--new-bundle-format` for releases after 0.1.0).
Replace `X.Y.Z` with the release you install:

```sh
cosign verify-attestation --type spdxjson \
  --certificate-identity https://github.com/netrics-so/netrics/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/netrics-so/server:X.Y.Z > /dev/null && echo verified
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

### Deleting a workspace

An owner deletes a workspace in its settings, by typing its name. Only
owners can, and nobody can delete their own only workspace: the owner must
be a member of another workspace first (any role counts). Other members are
not considered. Someone whose only workspace is deleted by its owner keeps
their account, and is asked to create a workspace at the next visit.

It happens in two steps.

1. **At once, in the request.** The workspace is marked deleted, and nobody
   reaches it any more: memberships and open invitations are removed, its
   screens are refused from their next request on, like a removed screen,
   running and waiting syncs end, and no new ones are planned. If work for the workspace
   is still running after 10 seconds, nothing is deleted and the owner is
   asked to try again.
2. **In the background, by the `worker`.** A `workspace.purge` job removes
   the data: every connection with its stored credentials and collected
   data, then datasets, models, dashboards and images, then the workspace
   itself with everything left (projects, themes, goals, screens, its own
   audit log). It works in small steps, so a restart continues where it
   stopped, and the `scheduler` queues the job again within the hour if it
   was lost. **Without a running `worker` the data stays in the database**,
   unreachable but not removed. A finished purge logs `workspace purged`
   (`docker compose logs worker`).

User accounts are not deleted with a workspace.

**Access granted through OAuth** (for example a Google account) is revoked
at the provider while a connection is purged, once, without retries. It is
not revoked when

- a connection of another workspace on this installation uses the same
  provider account: the grant is one and the same, so it is kept;
- the provider offers no way to revoke, or a custom API with OAuth names no
  revoke URL;
- the provider refuses or does not answer in time, the stored credential
  can no longer be decrypted, or a custom API no longer points at the host
  the credential was entered for (it is never sent anywhere else). The
  connection is removed all the same.

The second and third case count as `failed` below; the user can remove the
access in their account at the provider. A custom API that signs in with
client credentials has no user consent to withdraw and is not counted. API keys and other credentials you
entered are deleted from netrics, and stay valid at their provider until
you revoke them there.

**What stays.** Two audit entries that belong to the installation, not to a
workspace: no workspace member can read them, and the API does not return
them. Read them in the database:

```sh
docker compose exec postgres psql -U netrics -d netrics -c \
  "select created_at, action, target, actor_user_id, metadata from audit_events where workspace_id is null and action like 'workspace.%' order by created_at"
```

- `workspace.deleted`: who deleted it (`actor_user_id`), the workspace's id
  (`target`), its **name**, and how many members, connections, dashboards
  and screens it had.
- `workspace.purged`: the workspace's id, how many connections were removed,
  and how many OAuth grants were `revoked`, `failed` or `kept`. A grant
  that two connections of the deleted workspace shared counts as `kept` for
  the first and `revoked` for the last.

They are deleted after 12 months, like every audit entry. Container logs
keep the workspace's id for as long as you keep logs.

**Backups are not rewritten.** A dump taken before the deletion still holds
the workspace with all its data and encrypted credentials, until the dump is
deleted (the `backup` service keeps 14 days; copies you made elsewhere stay
until you remove them). Restoring such a dump brings the workspace back as
it was, with its members, and without the two audit entries. If the deletion
has to hold, have an owner delete the workspace again after the restore.
OAuth access that was revoked stays revoked: those connections fail until
they are connected again. A dump taken between the two steps holds the
workspace marked as deleted, and the purge continues after the restore.
