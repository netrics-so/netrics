# App Store Connect connector

Reads your apps' App Store sales (downloads, in-app purchases and proceeds)
from [App Store Connect](https://appstoreconnect.apple.com/), for one team
and one vendor number per connection
([ADR 0014](../decisions/0014-app-store-connect-signed-keys.md)).

> Status: connecting, the key check and app discovery are in place (#171).
> The daily sales sync follows in #172; until then a connection lists your
> apps but collects no values.

## Connect

Apple offers no "Sign in with Apple" for its API. You create an API key in
App Store Connect and upload it to netrics once:

1. Sign in to App Store Connect as the Account Holder or an Admin and open
   [Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api).
2. Under **Team Keys**, generate a key with the **Sales** role. Finance also
   works; Admin works too but grants far more than netrics needs.
   Individual keys cannot read sales reports and are not accepted.
3. Download the `.p8` file (Apple offers it only once), and copy the
   **Issuer ID** (above the key list) and the **Key ID** (in the key's row).
4. Find your **vendor number** in Payments and Financial Reports, under your
   legal entity name.

In netrics, enter the issuer ID, the key ID and the `.p8` file, and the
vendor number. Before anything is stored, netrics checks them against
Apple:

1. `GET /v1/apps?limit=1`: the issuer ID, key ID and private key must belong
   together, and the key must not be revoked.
2. The daily sales report of your vendor number for the latest published
   day: the key must have a role that reads sales reports, and the vendor
   number must belong to the team. A day without sales is fine.

netrics stores the key encrypted (AES-GCM, bound to the connection) and
signs a short-lived token (10 minutes) for every call. The connector itself
never sees the key, only the token. To rotate, upload a new key to the same
connection, then revoke the old one in App Store Connect; netrics cannot
revoke keys for you.

## Configuration

| Setting       | Meaning                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------- |
| Vendor number | The number in Payments and Financial Reports, under your legal entity name (digits only). |
| Apps          | The apps to collect, chosen from the apps of the key's team.                              |

The vendor number is not a secret, so it is part of the connection's
configuration, not of the key. A team with several vendor numbers (for
example after a legal-name change) uses one connection per vendor number.

Apps are identified by their numeric Apple ID, the same ID the sales
reports use. The platforms (iOS, macOS, tvOS, visionOS) are shown as a
label from the app's App Store versions; an app that never had a version is
listed as "app".

Connections of different teams can live side by side in one workspace, each
with its own key and vendor number.

## Limits

Apple allows about 3,500 requests per key and rolling hour, and reports the
rest in the `X-Rate-Limit` header. netrics stops a sync when fewer than 100
requests are left, and retries later; a 429 or a server error from Apple is
retried the same way. Connections that share one key share Apple's budget.

## When something goes wrong

| What you see                                                                           | What to do                                                                                                |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| "the issuer ID, key ID and private key do not belong together, or the key was revoked" | Check the three values, or create a new team key and upload it.                                           |
| "This key cannot read sales reports"                                                   | The key's role lacks sales access. Create a team key with the Sales role (roles cannot be changed later). |
| "App Store Connect does not know vendor number …"                                      | Copy the vendor number from Payments and Financial Reports.                                               |
| "requires an agreement that is missing or has expired"                                 | The Account Holder accepts the latest agreements in App Store Connect (Business).                         |
| "Upload a new App Store Connect key"                                                   | The key was revoked or its access removed after connecting. Upload a new key to the connection.           |
| "hourly request limit" / "not answering"                                               | Nothing: netrics retries automatically.                                                                   |

## Network access

The connector only talks to `api.appstoreconnect.apple.com`. Token signing
is done by the netrics server, not by connector code.
