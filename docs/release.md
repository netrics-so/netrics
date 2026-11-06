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
   environment-specific build inputs (one source, same commit; checked by
   the web build guard below). Until that cut-over (#161) the hosted web
   still runs the web image on Railway.
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

## Web build guard

The `web-build-env` CI job (`pnpm web:build-check`, script
`apps/web/scripts/build-env-check.ts`) makes "no environment-specific build
inputs" checkable (#160). It builds `apps/web` twice from a clean `.next`:

1. with only the build identity, `NEXT_PUBLIC_APP_VERSION` and
   `NEXT_PUBLIC_GIT_SHA`;
2. additionally with a sample value for every `NETRICS_*` name that appears
   in the web app's source or `next.config.ts`, plus `WEB_ORIGIN`
   (origin-style values for `*_URL`, `*_ORIGIN` and `*_HOST`).

It compares the whole build output except the cache, traces and the
`standalone` copy: client bundles in `.next/static`, prerendered pages and
route handlers (`.html`, `.rsc`, segments), server chunks and manifests.
Before comparing, the random build ID and the per-build draft-mode and
server-action keys are normalised; everything else is deterministic. The
job fails if any file differs, and names the variable when a sample value
appears in the output. This catches a module-scope `process.env` read that
ends up in a static page (directly or through a client component it
renders), a value inlined through `next.config.ts`, and a page that turns
static and renders configuration. A client component's own
`process.env.NETRICS_*` read is not inlined by Next.js (it is `undefined` in
the browser), so it is a bug but not a build input.

`web-build-env.test.ts` complements it: no tracked file may mention a
`NEXT_PUBLIC_*` variable other than the two identity values, because
Next.js inlines every one it finds in code.

The guard runs `next build`, which `vercel build` runs for Next.js projects
before it converts the output. `vercel build` itself is not run here: it
reads the linked project's settings (`.vercel/project.json`, normally
fetched with `vercel pull` and a token), and this public repository holds no
project identifiers or credentials. A stub project file would add the Vercel
CLI as a dependency to test only that conversion step.

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

## netrics TV releases

The Apple TV, iPhone and iPad app (`apps/netrics-tv`, one App Store app with
the bundle ID `tv.netrics`) has its own versions and its own workflow,
`.github/workflows/netrics-tv-release.yml` (#434). Its tags are
`netrics-tv/vX.Y.Z`; they never match the server's `vX.Y.Z`, and a server
release does not start it.

### Releasing

1. Create a GitHub Release with a new tag `netrics-tv/vX.Y.Z` on a `main`
   commit (`gh release create netrics-tv/v1.2.0 --target main --notes-file
notes.md`, or the web UI). The version is strict `X.Y.Z`: no suffixes, no
   leading zeros.
2. **Pre-release** (`--prerelease`): both apps are built, uploaded and
   processed, and land in TestFlight. Nothing is submitted.
3. **Full release**: the same, then version `X.Y.Z` of both platforms is
   created in App Store Connect (or the editable version is renamed to it),
   gets the new build, takes the release body as "What's New" in every
   localization (en-US and de-DE), and is submitted for App Review. What
   happens after approval follows the version's release option in App Store
   Connect (automatic by default).

Turning a pre-release into a full release later does not run the workflow
again (GitHub sends `released`, not `published`). To submit a version that
was tested in TestFlight, run the workflow on its tag:

```sh
gh workflow run netrics-tv-release.yml --ref netrics-tv/v1.2.0 -f submit=true
```

That builds and uploads a new build of the same version and submits it; the
release body of the tag, if it has a GitHub Release, becomes "What's New".
Without `-f submit=true` a manual run uploads to TestFlight only. A manual
run must use the tag as its ref, because the `app-store` environment admits
only `netrics-tv/v*` tags.

### What the workflow does

- `prepare` checks the tag (`apps/netrics-tv/scripts/asc-submit.ts version`)
  and picks the build number.
- `build (iOS)` and `build (tvOS)` run on the `xcode-27` image with
  `DEVELOPER_DIR` pinned to Xcode 27.1, like CI's `netrics-tv` job.
  `xcodebuild archive` signs automatically with `-allowProvisioningUpdates`
  and the API key (`-authenticationKeyPath`, `-authenticationKeyID`,
  `-authenticationKeyIssuerID`), with `DEVELOPMENT_TEAM`,
  `MARKETING_VERSION=X.Y.Z` and `CURRENT_PROJECT_VERSION=<build>` on the
  command line. `xcodebuild -exportArchive` with
  `apps/netrics-tv/Config/ExportOptions.plist` (method `app-store-connect`,
  destination `upload`, automatic signing, `manageAppVersionAndBuildNumber`
  off so the build number stays ours) uploads the app; the distribution
  certificate is cloud-managed, so no certificate or profile is stored
  anywhere. The team ID is added to a copy of the plist at run time.
- `app-store-connect` runs `apps/netrics-tv/scripts/asc-submit.ts run`, a
  dependency-free Node script on the App Store Connect API v1 (ES256 token
  from the built-in `crypto`, built-in `fetch`). It finds the app by bundle
  ID, waits up to 60 minutes per platform until the build is `VALID`, and on
  a full release attaches it, sets "What's New" (cut to Apple's 4000
  characters) and submits through `reviewSubmissions`. It prints the API's
  `errors[].detail` and fails on any error.

Every step can be repeated: "Re-run failed jobs" keeps the build number of
the first attempt, rebuilds only a failed platform, and the script finds the
version, build and review submission it already made. One release runs at a
time (concurrency group `netrics-tv-release`).

### Build numbers

The build number (`CFBundleVersion`) is the UTC time the run started,
`YYYYMMDD.HHMM` with the time as a plain integer: 2026-10-30 15:30 is
`20261030.1530`, 09:05 is `20261030.905`. Apple compares the components as
integers, so it only grows, across versions, runs and full re-runs, and fits
Apple's rule (up to three period-separated non-negative integers, each well
inside 32 bits). It does not depend on the workflow's run number, which
restarts if the workflow is renamed. Both platforms of a run share it.

### Secrets

The repository holds no account details. The GitHub environment `app-store`
(deployment rule: tags `netrics-tv/v*`) holds four secrets:

| Secret          | Value                                                 |
| --------------- | ----------------------------------------------------- |
| `ASC_API_KEY`   | The content of the API key file `AuthKey_<key id>.p8` |
| `ASC_KEY_ID`    | The key's ID                                          |
| `ASC_ISSUER_ID` | The issuer ID shown above the key list                |
| `APPLE_TEAM_ID` | The team ID (developer.apple.com, Membership)         |

Create the key in App Store Connect under Users and Access, Integrations,
App Store Connect API, Team Keys, with the Admin role: cloud-managed
distribution certificates and automatic provisioning need it. The `.p8` can
be downloaded once. Then:

```sh
gh secret set ASC_API_KEY -e app-store -R netrics-so/netrics < AuthKey_XXXXXXXXXX.p8
gh secret set ASC_KEY_ID -e app-store -R netrics-so/netrics
gh secret set ASC_ISSUER_ID -e app-store -R netrics-so/netrics
gh secret set APPLE_TEAM_ID -e app-store -R netrics-so/netrics
```

(each prompts for the value, which stays out of the shell history). The
jobs write the key to `$RUNNER_TEMP` with mode 0600, pass only its path, and
delete it in an `always()` step; GitHub masks all four values in logs. No
App Store Connect app ID is needed: the script looks the app up by its
bundle ID.

### The first submission

The API can submit a version only when App Store Connect has everything App
Review needs. Before the first full release, once, by hand in App Store
Connect:

- the app record for `tv.netrics` with both platforms (iOS and tvOS);
- the first version's metadata in en-US and de-DE: description, keywords,
  support URL, screenshots for each platform, App Privacy answers (see
  `apps/netrics-tv/README.md`, Privacy), age rating, category, price and
  availability, and App Review contact details (with a pairing code or demo
  instructions for the reviewer).

A missing item makes the submission step fail with Apple's error detail;
fill it in and re-run the failed job. The first version of an app has no
"What's New": Apple refuses the field, and the script logs that and goes on.
Later versions carry the metadata over and only need the notes.

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
