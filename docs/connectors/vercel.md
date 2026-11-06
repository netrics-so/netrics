# Vercel Web Analytics connector

Reads visitors, page views and custom events from
[Vercel Web Analytics](https://vercel.com/docs/analytics) for one or more
Vercel projects.

## Create a token

Use a token with the smallest scope that covers the projects you want to
see.

1. In Vercel, open **Account Settings → Tokens**
   (<https://vercel.com/account/settings/tokens>).
2. Name the token (for example "netrics") and set **Scope**:
   - **one project**: the token can read only that project. This is the
     smallest scope and the right choice for a single site.
   - **a team**: the token can read all of that team's projects, and you
     choose which ones to sync when you create the connection.
   - Avoid **Full Account** tokens. If you use one anyway, enter the team's
     ID (Team Settings → General, starts with `team_`) in the connection's
     **Team ID** field.
3. Choose an expiration. When the token expires, the connection stops
   syncing and asks for a new token. Nothing collected so far is lost.
4. Click **Create**, copy the token and paste it into netrics. Vercel shows
   it only once.

A Vercel token grants the same access you have within its scope. netrics
only reads the project list and Web Analytics with it. The token is stored
encrypted (AES-GCM, bound to the connection) and is never shown or logged.

Vercel's OAuth integrations cannot read Web Analytics (there is no analytics
scope), so this connector uses tokens.

## What is collected

Every value is a daily count per project, dated by Vercel's reporting day
(UTC).

| Metric              | Meaning                                               |
| ------------------- | ----------------------------------------------------- |
| Page views          | Page views                                            |
| Daily visitors      | Unique visitors that day                              |
| Page views by route | The 10 busiest routes of each month, rest as "Others" |
| Visitors by country | The 10 largest countries of each month, rest "Others" |
| Custom events       | The 10 most frequent events of each month, "Others"   |

- Summing daily visitors over several days counts a returning visitor once
  per day.
- While a month is still running, its top 10 can change. A route that drops
  out keeps the daily values it already has, so summing all routes for the
  current month can slightly overcount.

## History and refresh

- The first sync reads up to 366 days back. Plans that keep less (Hobby) are
  read as far back as Vercel allows.
- Afterwards the connection syncs every 15 minutes and re-reads yesterday
  and today, which Vercel is still counting.
- Vercel allows a limited number of API calls per minute. Short waits are
  absorbed; otherwise the sync is retried later and the dashboard shows the
  last values.

## When something goes wrong

| What you see                                           | What to do                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| "Vercel rejected the access token"                     | The token expired or was revoked. Create a new one and paste it into **Edit connection**. |
| "The token cannot see any projects"                    | Give the token the project's or team's scope.                                             |
| "Web Analytics is not enabled for …"                   | Enable Web Analytics in the project's **Analytics** tab in Vercel.                        |
| "The token no longer has access to … projects"         | Use a token that covers them, or remove them from the connection.                         |
| "Vercel's API rate limit is used up" / "not answering" | Nothing: netrics retries automatically.                                                   |

After a new token is saved, syncing restarts right away.

## Network access

The connector only talks to `api.vercel.com`.
