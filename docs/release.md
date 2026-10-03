# Release pipeline

The public repository owns application releases end to end up to the private
deploy boundary. Terraform never owns the image-version field; this pipeline
does (see `docs/architecture.md`, "Application release").

## Flow

1. **Merge to `main`** (or manual `workflow_dispatch` retry) triggers
   `.github/workflows/release.yml`. The concurrency group `release-production`
   guarantees only one release runs at a time.
2. **Verify.** The full check suite re-runs before anything is published:
   format, lint, typecheck, unit/integration tests, build, and database
   migrations against a throwaway PostgreSQL (including a re-apply idempotency
   check).
3. **Build once, per platform.** The server and web images are
   each built exactly once per platform, natively (`linux/amd64` on
   `ubuntu-24.04`, `linux/arm64` on `ubuntu-24.04-arm`, no QEMU), with
   `docker/build-push-action` and the GHA layer cache, and pushed by digest.
   The publish job joins each pair into a multi-arch index tagged with the
   immutable commit SHA: `ghcr.io/netrics-so/{server,web}:<sha>`. The
   release version (root `package.json` `version`) and commit SHA are baked in
   as build args (`APP_VERSION` / `GIT_SHA`; `NEXT_PUBLIC_*` for web), so the
   running API reports them on `/health/live` and `/health/ready`, and the web
   reports them on `/healthz` (`{"status":"ok","version":…,"commit":…}`) and
   displays them on its status page. Nothing environment-specific is baked
   into any image: the web image reads `NETRICS_API_URL` at request time, so
   the same image runs against any API. Self-hosters run these images. The
   hosted service runs the server image and, per ADR 0013, builds the web
   frontend on Vercel from the same commit and lockfile with no
   environment-specific build inputs (one source, same commit). Until that cut-over (#161) the
   hosted web still runs the web image on Railway.
4. **Record digests.** The index digest of each image
   (`ghcr.io/netrics-so/server@sha256:…`) goes to the job summary and to the
   dispatch below. Runtimes resolve the platform they need from the index.
5. **Sign and attest.** Cosign signs each index keylessly via sigstore GitHub
   OIDC (`id-token: write`), with `--recursive`, so the platform manifests are
   signed too. Syft generates an SPDX JSON SBOM per platform, and
   `cosign attest --type spdxjson` attaches it to that platform manifest and to
   the index. The SBOMs are also kept as the workflow artifact `sbom`.
6. **Dispatch.** The workflow sends a `repository_dispatch` event of type
   `release-candidate` to the private `netrics-so/netrics-cloud` repository
   with payload:

   ```json
   {
     "release": "0.1.0",
     "commit": "<sha>",
     "images": {
       "server": "ghcr.io/netrics-so/server@sha256:…",
       "web": "ghcr.io/netrics-so/web@sha256:…"
     }
   }
   ```

   The private workflow then runs migrations with the exact candidate server
   image, deploys in order (API/web, then worker/scheduler),
   health-gates the rollout, runs a smoke test, and records the digests in
   `release/production.yaml`. The smoke test compares the candidate commit
   with the `commit` reported by the API's `/health/live` and by the web's
   `/healthz`. Health probes (the Docker `HEALTHCHECK`, the platform's) check
   only the status code.

   Migrations run as the API's pre-deploy command: `node dist/migrate.js`, an
   entrypoint in the server image that applies the SQL migrations bundled in
   `@netrics/database` via drizzle-orm's programmatic migrator — no drizzle-kit
   dev dependency in the production image.

The dispatch is not automatically retried: if it fails, use "Re-run failed
jobs" on the run. That re-sends the dispatch with the digests the run already
published. A full re-run (or `workflow_dispatch`) rebuilds, and builds are
not bit-for-bit reproducible, so it moves the `<sha>` tag to new digests.

## Versioned releases

Every `main` commit is deployed to the hosted service. A version is a `main`
commit that self-hosters should run, marked with a git tag. Tagging never
rebuilds.

1. Bump `version` in the root `package.json` in a pull request (for
   example `0.2.0`) and merge it. The release run for that commit bakes the
   version into the images.
2. Tag that merge commit and push the tag:
   `git tag -a v0.2.0 <sha> -m v0.2.0 && git push origin v0.2.0`.
3. `.github/workflows/promote.yml` checks that the tag is `vX.Y.Z`, matches
   `package.json`, and points at a `main` commit. It waits for that commit's
   release run to publish, verifies the signature and the SBOM attestation
   against the `release.yml@refs/heads/main` identity, adds image tags to
   the existing index digests, and creates a GitHub release listing the
   digests. The image tags are:
   - `X.Y.Z`, immutable by convention;
   - `X.Y`, which follows the newest patch of that minor (it never moves
     back to an older patch).

Because tags are added by digest, the signatures and attestations made on
`main` apply to the version tags as they are. There is no `latest` tag:
installations name a version.

### Supported versions

netrics is pre-1.0. Only the newest `0.Y` minor gets fixes, as new patch
releases. Security fixes are released as a patch of the current minor. Minor
releases may change configuration; their release notes say what to do.

## Verifying an image

Every published image (commit and version tags, both platforms) is signed and
carries an SPDX SBOM attestation, both keyless via GitHub OIDC:

```sh
cosign verify \
  --certificate-identity https://github.com/netrics-so/netrics/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/netrics-so/server:0.2.0

cosign verify-attestation --type spdxjson \
  --certificate-identity https://github.com/netrics-so/netrics/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/netrics-so/server:0.2.0 | jq -r .payload | base64 -d | jq .predicate
```

## Pinning and dependency updates

- Every action is pinned by commit SHA (with the version in a comment), base
  images by digest, npm packages by exact version.
- Dependabot (`.github/dependabot.yml`) proposes updates weekly for actions,
  npm, the Dockerfiles, and `deploy/compose`. Its seven-day cooldown keeps
  releases younger than a week out. Major versions arrive as separate pull
  requests.
- Workflows start with `permissions: {}`, and each job asks only for what it
  uses: `packages: write` only where images are pushed, `id-token: write`
  only in the signing job, `contents: write` only for the GitHub release.

## Rollback

Rollback never rebuilds. The private repository's `release/production.yaml`
records every deployed digest set. Rolling back means redeploying the previous
recorded digests — the images, signatures, and SBOM attestations for that
commit already exist in GHCR from its original release. Database migrations follow the
expand/migrate/contract discipline so the previous application version stays
usable during normal rollback windows.

## Required GitHub setup

- **GHCR packages.** On first push, set the `server` and `web`
  packages to public under the `netrics-so` GHCR namespace and connect them to
  this repository so `GITHUB_TOKEN` (`packages: write`) can push.
- **netrics Release Bot GitHub App.** The dispatch into `netrics-cloud`
  authenticates as a GitHub App, not a personal token: the app lives in the
  `netrics-so` org, has `Contents: read and write`, and is installed on
  `netrics-cloud` only. Its app ID and private key live in the 1Password
  item "GitHub Release Bot" (vault "Lab80, netrics Infrastructure"); the
  workflow resolves them via the `op-secrets` composite action and mints a
  one-hour installation token at run time with
  `actions/create-github-app-token`.
- **`OP_SERVICE_ACCOUNT_TOKEN` secret.** This repository's own 1Password
  service account (`netrics-ci`, read-only on the vault). It is the one
  unavoidable long-lived GitHub secret; everything else resolves from `op://`
  references at run time. Replacement instructions are in the 1Password item
  "GitHub Actions Service Account Token, Public Repo".
- **Branch protection on `main`.** Require the `ci` workflow checks to pass
  before merging so the release workflow only runs on green commits.
