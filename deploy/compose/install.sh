#!/usr/bin/env sh
# netrics self-hosted installer: writes .env with generated secrets.
#
#   ./install.sh                         # interactive
#   ./install.sh --domain netrics.example.com [--version <image tag>] [--https-port 8443]
#
# Then: docker compose up -d, and open https://<domain>/setup.
set -eu

cd "$(dirname "$0")"

domain=""
version=""
https_port=443
force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) domain="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --https-port) https_port="$2"; shift 2 ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
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
  # Default to the release this checkout belongs to.
  version="$(git rev-parse HEAD 2>/dev/null || true)"
fi
[ -n "$version" ] || { echo "pass --version <image tag>" >&2; exit 1; }

if [ "$https_port" = "443" ]; then
  public_url="https://${domain}"
else
  public_url="https://${domain}:${https_port}"
fi

hex() { openssl rand -hex "$1"; }
b64() { openssl rand -base64 32; }

umask 077
cat > .env <<ENV
# netrics self-hosted configuration, generated $(date -u +%Y-%m-%dT%H:%M:%SZ).
# KEEP A BACKUP OF THIS FILE. APP_ENCRYPTION_KEY cannot be recovered: without
# it, stored connection credentials are lost.

NETRICS_DOMAIN=${domain}
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
