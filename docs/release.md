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
3. **Build once.** The server, web, and renderer images are each built exactly
   once with `docker/build-push-action` (GHA layer cache) and pushed to GHCR
   tagged with the immutable commit SHA:
   `ghcr.io/netrics-so/{server,web,renderer}:<sha>`. The release version (root
   `package.json` `version`) and commit SHA are baked in as build args
   (`APP_VERSION` / `GIT_SHA`; `NEXT_PUBLIC_*` for web), so the running API
   reports them on `/health/live` and `/health/ready` and the web status page
   displays them.
4. **Record digests.** The workflow captures the pushed digest of each image
   (`ghcr.io/netrics-so/server@sha256:…`) and writes them to the job summary.
5. **Sign and attest.** Cosign signs each image digest keylessly via sigstore
   GitHub OIDC (`id-token: write`). Syft SBOMs (SPDX JSON) are generated per
   image and attached as workflow artifacts (`sbom-server`, `sbom-web`,
   `sbom-renderer`).
6. **Dispatch.** The workflow sends a `repository_dispatch` event of type
   `release-candidate` to the private `netrics-so/netrics-cloud` repository
   with payload:

   ```json
   {
     "release": "0.1.0",
     "commit": "<sha>",
     "images": {
       "server": "ghcr.io/netrics-so/server@sha256:…",
       "web": "ghcr.io/netrics-so/web@sha256:…",
       "renderer": "ghcr.io/netrics-so/renderer@sha256:…"
     }
   }
   ```

   The private workflow then runs migrations with the exact candidate server
   image, deploys in order (API/web, then worker/scheduler/renderer),
   health-gates the rollout, runs a smoke test, and records the digests in
   `release/production.yaml`.

The dispatch is not automatically retried: if it fails, re-run the release
workflow manually (`workflow_dispatch`). Images, signatures, and SBOMs for the
commit are republished idempotently before the dispatch is re-sent.

## Rollback

Rollback never rebuilds. The private repository's `release/production.yaml`
records every deployed digest set. Rolling back means redeploying the previous
recorded digests — the images, signatures, and SBOMs for that commit already
exist in GHCR from its original release. Database migrations follow the
expand/migrate/contract discipline so the previous application version stays
usable during normal rollback windows.

## Required GitHub setup

- **GHCR packages.** On first push, set the `server`, `web`, and `renderer`
  packages to public under the `netrics` GHCR namespace and connect them to
  this repository so `GITHUB_TOKEN` (`packages: write`) can push.
- **`CLOUD_DISPATCH_TOKEN` secret.** A token that can dispatch workflows in the
  private `netrics-so/netrics-cloud` repository — either a GitHub App
  installation token source or a fine-grained PAT with `contents: write` on
  `netrics-cloud`. Store it as an Actions secret named `CLOUD_DISPATCH_TOKEN`
  in this repository. Without it the release workflow fails at the dispatch
  step (after publishing images), and the run must be retried manually.
- **Branch protection on `main`.** Require the `ci` workflow checks to pass
  before merging so the release workflow only runs on green commits.
