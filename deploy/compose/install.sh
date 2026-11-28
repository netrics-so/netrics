#!/usr/bin/env sh
# netrics self-hosted installer: writes .env with generated secrets.
#
#   ./install.sh                         # interactive
#   ./install.sh --domain netrics.example.com [--version <image tag>]
#       [--http-port 8080] [--https-port 8443] [--name netrics-selfhost]
#   ./install.sh --domain localhost       # try it on this machine
#
# Then: docker compose up -d, and open https://<domain>/setup.
set -eu

cd "$(dirname "$0")"

domain=""
version=""
http_port=80
https_port=443
name=netrics-selfhost
name_given=0
force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) domain="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --http-port) http_port="$2"; shift 2 ;;
    --https-port) https_port="$2"; shift 2 ;;
    --name) name="$2"; name_given=1; shift 2 ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

if [ -f .env ] && [ "$force" -ne 1 ]; then
  echo ".env already exists; refusing to overwrite secrets (use --force to replace it)." >&2
  exit 1
fi

if [ -z "$domain" ]; then
  printf "Domain for netrics (DNS must point here), e.g. netrics.example.com: "
  read -r domain
fi
[ -n "$domain" ] || { echo "a domain is required" >&2; exit 1; }

if [ -z "$version" ]; then
  # Default to the release this checkout is: a release tag vX.Y.Z gives the
  # image tag X.Y.Z. Any other checkout of main falls back to its commit,
  # which has images too but is not a release.
  tag="$(git describe --tags --exact-match --match 'v[0-9]*.[0-9]*.[0-9]*' HEAD 2>/dev/null || true)"
  if [ -n "$tag" ]; then
    version="${tag#v}"
  else
    version="$(git rev-parse HEAD 2>/dev/null || true)"
    [ -z "$version" ] || echo "note: not a release checkout; using images for commit ${version}. Prefer a release: git checkout vX.Y.Z" >&2
  fi
fi
[ -n "$version" ] || { echo "pass --version <image tag>" >&2; exit 1; }

for port in "$http_port" "$https_port"; do
  case "$port" in
    ''|*[!0-9]*) echo "not a port number: $port" >&2; exit 2 ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "port out of range (1-65535): $port" >&2; exit 2
  fi
done
# The Compose project name: containers and volumes are named after it
# (netrics-selfhost_pgdata). Two installations on one host need two names.
case "$name" in
  [abcdefghijklmnopqrstuvwxyz0123456789]*) ;;
  *) echo "--name must start with a lowercase letter or digit" >&2; exit 2 ;;
esac
case "$name" in
  *[!abcdefghijklmnopqrstuvwxyz0123456789_-]*) echo "--name may contain only a-z, 0-9, _ and -" >&2; exit 2 ;;
esac
# Installations made with 0.2.0 or older have no project name in .env, so
# Compose named them after this folder ("compose", volume compose_pgdata).
# A new name would start a second, empty installation next to that data:
# keep the old name unless --name asks for another.
folder_project="$(basename "$PWD" | LC_ALL=C tr 'A-Z' 'a-z' | LC_ALL=C tr -cd 'a-z0-9_-')"
if [ -n "$folder_project" ] && [ "$folder_project" != "$name" ] &&
  docker volume inspect "${folder_project}_pgdata" >/dev/null 2>&1; then
  if [ "$name_given" -eq 1 ]; then
    echo "warning: the volume ${folder_project}_pgdata holds an existing installation's database; --name ${name} starts a new, empty one." >&2
  else
    name="$folder_project"
    echo "note: keeping the Compose project name ${name} of the existing installation (volume ${name}_pgdata)." >&2
  fi
fi

if [ "$https_port" = "443" ]; then
  public_url="https://${domain}"
else
  public_url="https://${domain}:${https_port}"
fi

hex() { openssl rand -hex "$1"; }
b64() { openssl rand -base64 32; }

umask 077
# Backups hold all data: only this user may read them (compose.yml, backup).
mkdir -p backups
chmod 700 backups
# Extra certificate authorities to trust (README, "Custom APIs on your own
# network"); compose.yml mounts it into the api and the worker.
mkdir -p certs
chmod 755 certs

cat > .env <<ENV
# netrics self-hosted configuration, generated $(date -u +%Y-%m-%dT%H:%M:%SZ).
# KEEP A BACKUP OF THIS FILE. APP_ENCRYPTION_KEY cannot be recovered: without
# it, stored connection credentials are lost.

# Containers and volumes are named after the project (${name}_pgdata holds
# the database). Do not change it after the first start.
COMPOSE_PROJECT_NAME=${name}

NETRICS_DOMAIN=${domain}
NETRICS_HTTP_PORT=${http_port}
NETRICS_HTTPS_PORT=${https_port}
NETRICS_PUBLIC_URL=${public_url}
NETRICS_VERSION=${version}

POSTGRES_PASSWORD=$(hex 24)
NETRICS_APP_DB_PASSWORD=$(hex 24)
NETRICS_SCHEDULER_DB_PASSWORD=$(hex 24)

BETTER_AUTH_SECRET=$(b64)
APP_ENCRYPTION_KEY=$(b64)

# First-run setup: the only way to create the first (owner) account.
NETRICS_SETUP_TOKEN=$(hex 24)
NETRICS_SIGNUP=closed

# Optional email (invitations, password reset), e.g.
# SMTP_URL=smtps://user:password@smtp.example.com:465
# MAIL_FROM=netrics <no-reply@${domain}>

# Optional Google OAuth app (Google connectors; both or neither). Register
# the redirect URI ${public_url}/oauth/google/callback; see google-oauth.md.
# NETRICS_OAUTH_GOOGLE_CLIENT_ID=
# NETRICS_OAUTH_GOOGLE_CLIENT_SECRET=

# Display currency: the scheduler fetches the ECB euro reference rates daily
# from www.ecb.europa.eu. "off" makes no request and keeps amounts per
# currency.
# NETRICS_EXCHANGE_RATES=off

# Default language for people and screens without their own: en or de.
# NETRICS_DEFAULT_LOCALE=de

# Preview connectors (not final yet) to turn on, comma-separated; currently
# railway, posthog, hetzner-cloud and http-check.
# NETRICS_PREVIEW_CONNECTORS=

# Custom APIs on your own network (README): hosts they may reach, and a CA
# certificate in ./certs to trust for them.
# NETRICS_CUSTOM_API_PRIVATE_HOSTS=intranet.example

# Connectors on your own network (README): hosts a connector's configured
# host (a self-hosted PostHog) may resolve to.
# NETRICS_CONNECTOR_PRIVATE_HOSTS=posthog.internal.example
# NODE_EXTRA_CA_CERTS=/etc/netrics/certs/internal-ca.pem
ENV
chmod 600 .env

setup_token="$(sed -n 's/^NETRICS_SETUP_TOKEN=//p' .env)"
cat <<INFO
Wrote .env (mode 600) for ${domain}, images ${version}.

Next:
  docker compose up -d
  open ${public_url}/setup   and enter the setup token:
  ${setup_token}

Back up .env now (password manager or offline). Losing APP_ENCRYPTION_KEY
makes stored connection credentials unrecoverable.
INFO
if [ "$domain" = "localhost" ]; then
  cat <<INFO

localhost: Caddy signs the certificate with its own local CA, so the browser
warns about it once. Accept the warning to continue (README, "Try it locally").
INFO
fi
