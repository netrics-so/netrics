# Self-hosting netrics with Docker Compose

This runs the same images as the hosted service: web, api, worker, scheduler,
PostgreSQL and Caddy (automatic HTTPS). Every product feature is included; no
license key is needed.

## Requirements

- A Linux host with Docker Engine and the Compose plugin. Images are published
  for `linux/amd64`; `linux/arm64` follows with multi-arch releases (#45).
- A DNS name pointing at the host, with ports 80 and 443 reachable. Caddy
  obtains a Let's Encrypt certificate automatically.
- `openssl` (used by the installer to generate secrets).

## Install

```sh
git clone https://github.com/netrics-so/netrics.git
cd netrics/deploy/compose
./install.sh --domain netrics.example.com
docker compose up -d
```

`install.sh` writes `.env` with mode 600. It pins the image version to the
checked-out release and generates every secret:

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
| `scheduler` | Plans due syncs                                                                                     |
| `web`       | Web app; proxies the API                                                                            |
| `caddy`     | HTTPS termination; the only published ports                                                         |
| `backup`    | Optional nightly `pg_dump` into `./backups`, 14 days kept (`docker compose --profile backup up -d`) |

## Upgrade

1. Back up (see below).
2. Set `NETRICS_VERSION` in `.env` to the new release.
3. Run `docker compose pull && docker compose up -d`.

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

## Operations

- Logs: `docker compose logs -f api worker scheduler`
- Service tokens for automation or an admin console:
  `docker compose run --rm migrate node dist/admin-cli.js create-service-token --name ops --scope installation:workspaces:read`
- Rotating the encryption key: see the main README, "Rotating the encryption
  key". Run `reencrypt-credentials` the same way.
