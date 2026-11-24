# HTTP checks connector

Requests the URLs a connection lists once a minute and records for each
whether it is up, with its status code and response time ([#874](https://github.com/netrics-so/netrics/issues/874),
milestone 13.1). A check that is down is data, never a failed sync.

HTTP checks are a preview connector (milestone 13.1): listed in
development, and in production only when the operator names `http-check` in
`NETRICS_PREVIEW_CONNECTORS` (see `deploy/compose/README.md`), until the
milestone's exit gate passes.

## Set up checks

A connection holds 1 to **20** checks. Each check has:

| Field                | Default   | Meaning                                                                                                      |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| Name                 | —         | Names the check on dashboards; unique in the connection (case does not matter). It is the check's identity   |
| URL                  | —         | An `https` URL, host a full domain name or an IP address, any port, path and query; at most 2,048 characters |
| Method               | `GET`     | `GET` or `HEAD` (status and headers only)                                                                    |
| Expected status      | `200-399` | A code (`200`), a range (`200-299`), a class (`2xx`), or up to ten separated by commas, within 100–599       |
| Expected text        | —         | `GET` only: text the body must contain, at most 200 characters                                               |
| Time limit (seconds) | 10        | 1 to 10                                                                                                      |
| Request headers      | —         | One `Name: value` per line, at most ten                                                                      |

The configuration is not encrypted, so it holds no secrets: request headers
that carry them (`Authorization`, `Cookie`, any name with `auth`, `token`,
`key`, `secret`, `cookie`, `session`, `password` or `signature`) are
refused, as are `Host`, `Content-Length`, `Connection`, `Transfer-Encoding`
and the other hop-by-hop headers. A check of an endpoint that needs a
credential is not supported yet (see "Not yet").

The connection check validates the list and requests nothing: a site that
is down is what a check is for, not a reason to refuse the connection. It
fails with a reason when:

| Code                         | When                                                                       |
| ---------------------------- | -------------------------------------------------------------------------- |
| `http_check.no_checks`       | No check, or more than 20                                                  |
| `http_check.url_invalid`     | A URL is not https, has a user name or password, or names no full host     |
| `http_check.name_duplicate`  | A name is empty or another check has it                                    |
| `http_check.status_invalid`  | An expected status cannot be read                                          |
| `http_check.text_invalid`    | Expected text on a `HEAD` check                                            |
| `http_check.headers_invalid` | A header line is malformed, carries a secret, is reserved, or one too many |

A sync of a configuration that fails these fails with the same code.

Because the connection carries no credentials, its URLs may point at other
hosts after it was created (ADR 0027 §2 fixes the hosts only of connectors
that carry credentials).

## Where checks may go (egress)

The URLs' hosts reach the connection's egress allowlist through the
manifest's `configuredHosts: ["checks[].url"]` (SDK 0.2.21), for that
connection only. The server gives HTTP checks their own egress values
(`httpCheckEgress`, ADR 0027 §3):

- **https only.** The egress guard allows plain http only in tests, so a
  check URL is https; an http URL is refused in the configuration.
- **Public addresses on the hosted service.** A name that resolves to a
  private, loopback or metadata address is refused (the check is down with
  `egress_refused`). A self-hosted instance lets checks reach the private
  hosts and ranges it lists in `NETRICS_CUSTOM_API_PRIVATE_HOSTS`, the same
  list custom APIs use; metadata and link-local addresses stay refused even
  when listed. DNS answers are pinned for the run.
- **Redirects on the same host only.** A `GET` or `HEAD` follows at most
  three redirects to the same scheme, host and port; a redirect anywhere
  else, even to another check's host, makes the check down with `redirect`.
  The runtime forces this for every configured item URL, whatever the call
  site passes.
- **Bounds.** At most 10 seconds per request (a check's own time limit
  lowers it) and 1 MiB of body (decoded too). A body is read only when a
  check has expected text; otherwise only the status and headers are
  awaited. A run requests ten checks at a time, so 20 checks fit in the
  host's 60-second call.

## What is collected

**Resources** are the checks (`kind: check`), named by a hash of their name
(`check-<16 hex>`): a check keeps its identity, and its links to workspace
projects, while its URL or expectations change. Renaming a check makes it
a new resource.

**Dataset `checks`** (snapshot, 30 days): one row per check as of its last
run, replaced by every run that requested every check.

| Field             | Type      | Meaning                                                     |
| ----------------- | --------- | ----------------------------------------------------------- |
| `check_id`        | string    | The resource id (key)                                       |
| `name`            | string    | The check's name                                            |
| `url`             | string    | The URL without its query string (a query may carry values) |
| `host`            | string    | The URL's host                                              |
| `method`          | string    | `GET` or `HEAD`                                             |
| `expected_status` | string    | As configured                                               |
| `state`           | string    | `up` or `down`, the status widget's words (#875)            |
| `reason`          | string    | Why it is down (below); null when up                        |
| `status_code`     | integer   | The answer's status; null without an answer                 |
| `response_ms`     | integer   | Milliseconds until the answer; null without one             |
| `checked_at`      | timestamp | When the run requested it                                   |
| `last_change_at`  | timestamp | Since when the state holds; null until a run sees it change |

Reasons a check is down, fixed codes that never carry what the checked site
answered (its body is only searched for the expected text, and nothing of
it is stored, logged or put in an error):

| Reason              | When                                                            |
| ------------------- | --------------------------------------------------------------- |
| `timeout`           | No answer within the time limit                                 |
| `dns`               | The host name does not resolve                                  |
| `tls`               | The TLS handshake or the certificate failed                     |
| `refused`           | The host refused the connection                                 |
| `connection`        | The connection failed otherwise (reset, unreachable)            |
| `unexpected_status` | An answer with another status than expected                     |
| `text_missing`      | The expected text is not in the body                            |
| `too_large`         | The body is larger than 1 MiB (only read with expected text)    |
| `redirect`          | A redirect to another host, or more than three                  |
| `egress_refused`    | netrics may not reach the address (private, loopback, metadata) |

**Metrics**, per check (the `resource` dimension) and per run, timestamped
at the run (granularity `instant`, not daily):

| Metric                   | Unit    | Value                                                |
| ------------------------ | ------- | ---------------------------------------------------- |
| `http-check.up`          | `ratio` | 1 when up, 0 when down                               |
| `http-check.response_ms` | `ms`    | Milliseconds until the answer, for runs that got one |

### Uptime

Uptime over a period is the average of `http-check.up` over it: a tile or
measure with aggregation `avg` shows it as a share (0.998 = 99.8 %); a
formula measure that multiplies it by 100 shows percent. Only runs that
happened count: a period with no run has no uptime rather than 100 %. A
per-project uptime averages the checks linked to the project, each run of
each check weighing the same.

### Freshness (ADR 0025)

One continuous stream, `checks`, holding both metrics and the dataset. A
finished run reports it for every check it requested, per check. A run
that did not finish (the host ended the call, or the server stopped
between its pages) reports nothing and completes no snapshot.

### How a sync proceeds

A run is two pages:

1. Every check is requested once, ten at a time. The page carries the
   observations and the snapshot rows on an incomplete dataset page, and a
   run cursor.
2. The final page carries nothing but the empty page that completes the
   snapshot, the received dataset and the freshness of every check (the
   host refuses a final result with an incomplete page, ADR 0026 §7).

The run cursor is bound to the connection and a fingerprint of the
configuration (every check's name, URL, method, expectations, time limit
and headers) and of the credentials (none today); it holds check ids,
states and times, never a URL, header, answer or secret. A run cursor of
another connection or configuration, or one older than two minutes (a run
whose second page never came), starts a new run, so old results never
complete a snapshot or claim freshness. A finished run leaves each check's
state, since when it holds and a fingerprint of the check, so the next run
knows when a state changed; a check whose URL or expectations changed starts
without a previous state.

Only infrastructure failures fail a sync: a configuration it cannot run
(with its reason code) or the host ending the call. Everything a checked
site does is a down result.

## Limits and load

- **Interval:** once a minute (`minRefreshIntervalSeconds: 60`), which is
  also the floor; the scheduler keeps at most one waiting sync per
  connection, so a slow run never piles up runs.
- **Per connection:** at most 20 checks, so at most 20 requests a minute,
  ten at a time.
- **Per request:** 10 seconds and 1 MiB at most.
- The sent `User-Agent` is `netrics-http-check/1`, with `Cache-Control:
no-cache`.

## Not yet

- Checks that need a credential (an `Authorization` header). They would
  take a token credential bound to the checks' hosts (ADR 0027 §2), which
  would then fix the hosts per connection.
- A per-workspace limit on checks; today the bound is per connection.
- An interval longer than a minute per check, and checks from several
  regions (out of scope for milestone 13.1).
- Plain http: the egress guard allows only https outside tests.
