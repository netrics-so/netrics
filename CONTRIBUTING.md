# Contributing to netrics

Thank you for your interest in netrics.

## Current status

netrics is in early development toward v1. The roadmap lives in
[`docs/milestones`](docs/milestones/README.md) and on the GitHub milestones
and project board.

Contributions are welcome right now in these forms:

- **Bug reports and feature requests:** use the issue templates.
- **Questions, ideas and connector wishes:** use
  [GitHub Discussions](https://github.com/netrics-so/netrics/discussions).
- **Security problems:** see [SECURITY.md](SECURITY.md). Never report them in
  public.

We are not yet accepting external code contributions. The contributor
agreement is still under review; this file will change when it is ready.

## Licensing

- The netrics server, web application and all other packages are licensed
  under the [GNU Affero General Public License v3.0](LICENSE).
- The connector SDK (`packages/connector-sdk`) is licensed under the
  [Apache License 2.0](packages/connector-sdk/LICENSE), so connectors can be
  built under any license.

The netrics name and logo are trademarks and are not covered by these
licenses.

## Development

See the [README](README.md) for setup, and the
[architecture](docs/architecture.md) and [decisions](docs/decisions/README.md)
documents for design context. Every change keeps `pnpm lint`,
`pnpm typecheck` and `pnpm test` green.
