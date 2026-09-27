# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/netrics-so/netrics/security/advisories/new).
Do not open a public issue, discussion or pull request for a security problem.

Please include:

- The affected component and version or commit
- Steps to reproduce, or a proof of concept
- The impact you expect (for example, cross-workspace data access or
  credential exposure)

We aim to acknowledge reports within three business days and to agree on a
disclosure timeline with you. We credit reporters in the advisory unless you
prefer otherwise.

## Scope

In scope: this repository. That covers the API, worker, scheduler, web app,
connector runtime and SDK, first-party connectors, published container images
and the Docker Compose deployment.

The hosted netrics service is operated separately. Report issues affecting it
through the same channel.

## Supported versions

netrics is pre-1.0. Security fixes land on `main` and in the next release.
Self-hosted installations should run the latest release.
