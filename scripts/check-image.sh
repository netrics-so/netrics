#!/usr/bin/env bash
# Checks a built server or web image before it ships (#906). CI runs it on
# every pull request; the release runs it on each pushed digest before
# signing, so the exact image that is deployed has passed it.
#
#   scripts/check-image.sh <image>
#
# 1. Node runs, as the unprivileged node user, with its license alongside.
# 2. No npm: the runtime stage is plain Alpine plus the Node binary.
# 3. The Node runtime has every security release of its major line that is
#    out for more than 3 days (time for the official node image to catch
#    up). Trivy does not recognise the copied binary, so this checks the
#    version against nodejs.org. Fix: bump the node digest in the Dockerfiles.
# 4. No known high or critical vulnerability that has a fix (Trivy). Fix:
#    bump the base digests (Renovate proposes them) or the dependency.
set -euo pipefail

image=${1:?usage: scripts/check-image.sh <image>}
trivy=aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb

fail() {
  echo "::error::${image}: $*"
  exit 1
}

version=$(docker run --rm --entrypoint node "$image" -p process.version)
user=$(docker run --rm --entrypoint id "$image" -un)
echo "${image}: Node ${version}, user ${user}"
[ "$user" = node ] || fail "runs as ${user}, not node"
docker run --rm --entrypoint sh "$image" -c 'test -s /usr/local/share/licenses/node/LICENSE' ||
  fail "ships the Node binary without its license"

if docker run --rm --entrypoint sh "$image" -c \
  'command -v npm || command -v npx || test -d /usr/local/lib/node_modules'; then
  fail "ships npm"
fi

cutoff=$(date -u -d '3 days ago' +%F)
missing=$(curl -fsS --retry 3 https://nodejs.org/dist/index.json | jq -r \
  --arg v "$version" --arg cutoff "$cutoff" '
  [.[] | select(.version | startswith(($v | split(".")[0]) + "."))] as $line
  | ($line | map(.version) | index($v)) as $i
  | if $i == null then "unknown version \($v)"
    else $line[:$i] | map(select(.security and .date <= $cutoff) | .version) | join(" ")
    end')
[ -z "$missing" ] || fail "Node ${version} is missing security release(s): ${missing}"

mkdir -p "${RUNNER_TEMP:-/tmp}/trivy"
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "${RUNNER_TEMP:-/tmp}/trivy:/root/.cache" \
  "$trivy" image --quiet --table-mode detailed --scanners vuln --ignore-unfixed \
  --severity HIGH,CRITICAL --exit-code 1 "$image" ||
  fail "has fixable high or critical vulnerabilities (listed above)"
