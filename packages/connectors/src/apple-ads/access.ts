import { z } from "zod";

import {
  AppleAdsApiError,
  AppleAdsRateBudgetError,
  isAdAccountId,
  type AppleAdsClient,
} from "./api.js";

// Access, ad-account discovery and campaign discovery (ADR 0020 section 5,
// #373). One connection reads one ad account; `/v1/acls` says which ad
// accounts the API user may read and with which roles, `/v1/ad-accounts/
// {id}` says whether an account is an App Store account and gives its
// currency and time zone, and `/v1/campaigns/query` names its campaigns.
//
// Apple's documentation, checked 2026-10-29:
// - Access overview (`X-AP-Context`, which calls take none, `/v1/acls` and
//   `/v1/ad-accounts/{id}` examples, productFeatures):
//   https://developer.apple.com/documentation/apple-ads-platform-api/access-overview
// - Get User ACL ("Each access token binds to exactly one org"):
//   https://developer.apple.com/documentation/apple-ads-platform-api/get-user-acls
// - UserAcl (roles: Admin, API Account Manager, API Account Read Only,
//   Limited Access: API Read & Write, Limited Access: API Read Only):
//   https://developer.apple.com/documentation/apple-ads-platform-api/useracl
// - AdAccount (id, name, orgId, timezone, currency, systemStatus,
//   systemStatusReasons, productFeatures):
//   https://developer.apple.com/documentation/apple-ads-platform-api/adaccount
// - ProductFeatures (APPSTORE_APP_MANUAL or BUSINESS_BRAND_MANUAL, never
//   both): https://developer.apple.com/documentation/apple-ads-platform-api/productfeatures
// - Query Campaigns (POST /v1/campaigns/query, pageSize at most 1000,
//   deleted campaigns only when filtered for) and Campaign:
//   https://developer.apple.com/documentation/apple-ads-platform-api/post-campaigns-query
//   https://developer.apple.com/documentation/apple-ads-platform-api/campaign
// - Search Apps (GET /v1/apps/{adamId}: appName):
//   https://developer.apple.com/documentation/apple-ads-platform-api/search-apps-endpoints

/** A probe's or check's answer: a CheckResult whose failure has a message. */
export type AccessResult = { ok: true } | { ok: false; message: string };

/**
 * The roles that read the API (UserAcl's roles reference). The read-only
 * ones are what the setup asks for; the others read too. Any other value
 * is a UI role without API access. TO BE CONFIRMED by #370: the role
 * strings an API Read Only user's ACL carries.
 */
export const API_ROLES: readonly string[] = [
  "API Account Read Only",
  "Limited Access: API Read Only",
  "API Account Manager",
  "Limited Access: API Read & Write",
  "Admin",
];

/** The product feature of App Store ad accounts. */
export const APP_STORE_FEATURE = "APPSTORE_APP_MANUAL";
/** The product feature of Apple Maps (business-brand) ad accounts. */
export const APPLE_MAPS_FEATURE = "BUSINESS_BRAND_MANUAL";

export const NO_AD_ACCOUNTS_MESSAGE =
  "This Apple Ads API user has no ad accounts. Ask an Account Admin to give the user an API role (API Account Read Only) in the ad account you want to connect.";

export const ROLE_MESSAGE =
  "The Apple Ads API user needs an API role, such as API Account Read Only, in the ad account. A non-API role removes API access. Ask an Account Admin to change the role under Account Settings → User Management.";

export const APPLE_MAPS_MESSAGE = "Apple Maps ads are not supported yet.";

export const NO_APP_STORE_ACCOUNT_MESSAGE =
  "This Apple Ads API user can read only Apple Maps ad accounts. Apple Maps ads are not supported yet; netrics reads App Store ad accounts.";

export const RATE_LIMITED_MESSAGE =
  "Apple Ads' request limit for this API user is used up. Try again in a few minutes.";

/** The configured ad account is no longer in the API user's ACL. */
export function lostAccessMessage(adAccountId: string): string {
  return `This Apple Ads API user no longer has access to ad account ${adAccountId}. Ask an Account Admin to give the user an API role in that ad account again, or set up a new key.`;
}

/** At most this many ad accounts are looked up per discovery. */
export const MAX_AD_ACCOUNTS = 50;
/** Campaigns per query page (Apple's cap for /v1/campaigns/query). */
export const CAMPAIGNS_PAGE_SIZE = 1000;
/** Campaign pages per discovery (20,000 campaigns). */
export const MAX_CAMPAIGN_PAGES = 20;
/** App names looked up per discovery. */
export const MAX_APPS = 50;

/**
 * An Apple ID (int64): a digit string, or a JSON number Apple sends (the
 * documentation shows numbers for ad account, org and campaign IDs). A
 * number beyond 2^53 has lost digits and is refused.
 */
const appleIdSchema = z
  .union([
    z.string().regex(/^\d{1,19}$/),
    z
      .number()
      .int()
      .nonnegative()
      .refine((value) => Number.isSafeInteger(value)),
  ])
  .transform((value) => BigInt(value).toString());

const aclSchema = z.object({
  result: z
    .object({
      acls: z
        .array(
          z
            .object({
              adAccount: z
                .object({
                  id: appleIdSchema,
                  name: z.string().nullable().optional(),
                  orgId: appleIdSchema.nullable().optional(),
                })
                .loose(),
              roles: z.array(z.string()).nullable().optional(),
            })
            .loose(),
        )
        .nullable()
        .optional(),
    })
    .loose(),
});

export interface AclEntry {
  adAccountId: string;
  name: string;
  orgId: string | undefined;
  roles: string[];
  /** Whether one of the roles reads the API (API_ROLES). */
  apiAccess: boolean;
}

/** `GET /v1/acls` (no context header): the ad accounts and roles. */
export async function listAcls(client: AppleAdsClient): Promise<AclEntry[]> {
  const parsed = aclSchema.safeParse(await client.json("/v1/acls"));
  if (!parsed.success) {
    throw new Error("Apple Ads answered /v1/acls in an unexpected shape");
  }
  return (parsed.data.result.acls ?? []).map((acl) => {
    const roles = acl.roles ?? [];
    const id = acl.adAccount.id;
    return {
      adAccountId: id,
      name: acl.adAccount.name?.trim() || `Ad account ${id}`,
      orgId: acl.adAccount.orgId ?? undefined,
      roles,
      apiAccess: roles.some((role) => API_ROLES.includes(role)),
    };
  });
}

const adAccountSchema = z.object({
  result: z
    .object({
      id: appleIdSchema,
      name: z.string().nullable().optional(),
      orgId: appleIdSchema.nullable().optional(),
      timezone: z.string().nullable().optional(),
      currency: z.string().nullable().optional(),
      systemStatus: z.string().nullable().optional(),
      systemStatusReasons: z.array(z.string()).nullable().optional(),
      productFeatures: z.array(z.string()).nullable().optional(),
    })
    .loose(),
});

export interface AdAccountDetails {
  id: string;
  name: string | undefined;
  orgId: string | undefined;
  /** IANA zone of the account's reporting days ("America/New_York"). */
  timeZone: string | undefined;
  /** ISO 4217 code of the account's spend ("USD"). */
  currency: string | undefined;
  /** "ACTIVE" or "INACTIVE". */
  systemStatus: string | undefined;
  systemStatusReasons: string[];
  productFeatures: string[];
}

/** `GET /v1/ad-accounts/{id}` with the account's own context header. */
export async function getAdAccount(
  client: AppleAdsClient,
  adAccountId: string,
): Promise<AdAccountDetails> {
  const parsed = adAccountSchema.safeParse(
    await client.json(`/v1/ad-accounts/${adAccountId}`, { adAccountId }),
  );
  if (!parsed.success || parsed.data.result.id !== adAccountId) {
    throw new Error(
      "Apple Ads answered /v1/ad-accounts in an unexpected shape",
    );
  }
  const account = parsed.data.result;
  return {
    id: account.id,
    name: account.name?.trim() || undefined,
    orgId: account.orgId ?? undefined,
    timeZone: account.timezone ?? undefined,
    currency: account.currency ?? undefined,
    systemStatus: account.systemStatus ?? undefined,
    systemStatusReasons: account.systemStatusReasons ?? [],
    productFeatures: account.productFeatures ?? [],
  };
}

/** An ad account as discovery lists it, joined from the ACL and its details. */
export interface DiscoveredAdAccount {
  acl: AclEntry;
  details: AdAccountDetails;
  /** App Store account with an API role: it can be connected. */
  selectable: boolean;
  /** Why it cannot be connected, when it cannot. */
  reason: string | undefined;
}

function reasonOf(
  acl: AclEntry,
  details: AdAccountDetails,
): string | undefined {
  if (!acl.apiAccess) return ROLE_MESSAGE;
  if (details.productFeatures.includes(APP_STORE_FEATURE)) return undefined;
  if (details.productFeatures.includes(APPLE_MAPS_FEATURE)) {
    return APPLE_MAPS_MESSAGE;
  }
  return "This ad account runs no App Store campaigns.";
}

/**
 * The API user's ad accounts with their details (at most MAX_AD_ACCOUNTS).
 * Accounts without an API role are listed without a details call: Apple
 * would refuse it.
 */
export async function discoverAdAccounts(
  client: AppleAdsClient,
): Promise<DiscoveredAdAccount[]> {
  const acls = (await listAcls(client)).slice(0, MAX_AD_ACCOUNTS);
  const accounts: DiscoveredAdAccount[] = [];
  for (const acl of acls) {
    const details: AdAccountDetails = acl.apiAccess
      ? await getAdAccount(client, acl.adAccountId)
      : {
          id: acl.adAccountId,
          name: undefined,
          orgId: acl.orgId,
          timeZone: undefined,
          currency: undefined,
          systemStatus: undefined,
          systemStatusReasons: [],
          productFeatures: [],
        };
    const reason = reasonOf(acl, details);
    accounts.push({ acl, details, selectable: reason === undefined, reason });
  }
  return accounts;
}

/** The configured ad account, or undefined (none, or malformed). */
export function adAccountIdOf(
  config: Readonly<Record<string, unknown>>,
): string | undefined {
  const raw = config.adAccountId;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return String(raw);
  }
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return isAdAccountId(value) ? value : undefined;
}

export const AD_ACCOUNT_FORMAT_MESSAGE =
  "The ad account ID is the number Apple Ads shows for the ad account (digits only).";

/**
 * The key and role check (ADR 0020 section 5): the same check runs on the
 * host before a key is stored (the provider's probe, after the token
 * exchange) and in the connector's check before every sync, so an API user
 * who lost the account or its API role later is caught the same way.
 *
 * With a configured ad account: it must be in `/v1/acls` with an API role
 * and be an App Store account. Without one (the wizard's preview, before an
 * account is chosen): at least one ad account must qualify.
 *
 * A 403 is the role message; 401, 429 and 5xx are thrown (the host
 * re-exchanges, or the job retries).
 */
export async function checkAccess(
  client: AppleAdsClient,
  config: Readonly<Record<string, unknown>>,
): Promise<AccessResult> {
  const configured = config.adAccountId;
  const adAccountId = adAccountIdOf(config);
  if (
    configured !== undefined &&
    configured !== "" &&
    adAccountId === undefined
  ) {
    return { ok: false, message: AD_ACCOUNT_FORMAT_MESSAGE };
  }
  try {
    const acls = await listAcls(client);
    if (acls.length === 0) {
      return { ok: false, message: NO_AD_ACCOUNTS_MESSAGE };
    }
    if (adAccountId !== undefined) {
      const acl = acls.find((entry) => entry.adAccountId === adAccountId);
      if (!acl) {
        return { ok: false, message: lostAccessMessage(adAccountId) };
      }
      if (!acl.apiAccess) {
        return { ok: false, message: ROLE_MESSAGE };
      }
      const details = await getAdAccount(client, adAccountId);
      const reason = reasonOf(acl, details);
      return reason === undefined
        ? { ok: true }
        : {
            ok: false,
            message:
              reason === APPLE_MAPS_MESSAGE
                ? NO_APP_STORE_ACCOUNT_MESSAGE
                : reason,
          };
    }
    const readable = acls.filter((entry) => entry.apiAccess);
    if (readable.length === 0) {
      return { ok: false, message: ROLE_MESSAGE };
    }
    for (const acl of readable.slice(0, MAX_AD_ACCOUNTS)) {
      const details = await getAdAccount(client, acl.adAccountId);
      if (details.productFeatures.includes(APP_STORE_FEATURE)) {
        return { ok: true };
      }
    }
    return { ok: false, message: NO_APP_STORE_ACCOUNT_MESSAGE };
  } catch (error) {
    if (error instanceof AppleAdsApiError && error.status === 403) {
      return { ok: false, message: ROLE_MESSAGE };
    }
    throw error;
  }
}

/** Whether an error means "the request limit is used up, try later". */
export function isRateLimited(error: unknown): boolean {
  return (
    error instanceof AppleAdsRateBudgetError ||
    (error instanceof AppleAdsApiError && error.status === 429)
  );
}

const campaignPageSchema = z.object({
  result: z
    .array(
      z
        .object({
          id: appleIdSchema,
          name: z.string().nullable().optional(),
          adAccountId: appleIdSchema.nullable().optional(),
          promotedObjectType: z.string().nullable().optional(),
          promotedObjectId: z.string().nullable().optional(),
          status: z.string().nullable().optional(),
          displayStatus: z.string().nullable().optional(),
          deleted: z.boolean().nullable().optional(),
        })
        .loose(),
    )
    .nullable()
    .optional(),
  pagination: z
    .object({
      totalCount: z.number().int().nonnegative().nullable().optional(),
      offset: z.number().int().nonnegative().nullable().optional(),
      pageSize: z.number().int().nonnegative().nullable().optional(),
    })
    .loose()
    .nullable()
    .optional(),
});

export interface AppleAdsCampaign {
  id: string;
  name: string;
  /** The promoted app's Adam ID (App Store campaigns). */
  appId: string | undefined;
  /** "ENABLED" or "PAUSED": the advertiser's intent. */
  status: string | undefined;
  /** Apple's rolled-up delivery state ("RUNNING", …). */
  displayStatus: string | undefined;
}

/**
 * The App Store campaigns of one ad account, all pages of `POST
 * /v1/campaigns/query` (at most MAX_CAMPAIGN_PAGES). Apple leaves deleted
 * campaigns out unless filtered for; their stored names stay (resources
 * missing from a discovery keep their last name).
 */
export async function listCampaigns(
  client: AppleAdsClient,
  adAccountId: string,
): Promise<AppleAdsCampaign[]> {
  const campaigns = new Map<string, AppleAdsCampaign>();
  for (let page = 0; page < MAX_CAMPAIGN_PAGES; page += 1) {
    const offset = page * CAMPAIGNS_PAGE_SIZE;
    const parsed = campaignPageSchema.safeParse(
      await client.json("/v1/campaigns/query", {
        adAccountId,
        body: {
          filters: [
            {
              field: "promotedObjectType",
              operator: "EQUALS",
              value: "APPSTORE_APP",
            },
          ],
          sorting: [{ field: "id", order: "ASC" }],
          pagination: {
            offset,
            pageSize: CAMPAIGNS_PAGE_SIZE,
            fetchTotalCount: true,
          },
        },
      }),
    );
    if (!parsed.success) {
      throw new Error(
        "Apple Ads answered /v1/campaigns/query in an unexpected shape",
      );
    }
    const rows = parsed.data.result ?? [];
    for (const row of rows) {
      if (
        row.adAccountId !== undefined &&
        row.adAccountId !== null &&
        row.adAccountId !== adAccountId
      ) {
        // A campaign of another account must never be named here.
        throw new Error(
          "Apple Ads answered with another ad account's campaign",
        );
      }
      if (row.deleted === true) continue;
      if (row.promotedObjectType && row.promotedObjectType !== "APPSTORE_APP") {
        continue;
      }
      const appId = row.promotedObjectId?.trim();
      campaigns.set(row.id, {
        id: row.id,
        name: row.name?.trim() || `Campaign ${row.id}`,
        appId: appId && /^\d{1,19}$/.test(appId) ? appId : undefined,
        status: row.status ?? undefined,
        displayStatus: row.displayStatus ?? undefined,
      });
    }
    const total = parsed.data.pagination?.totalCount ?? undefined;
    const read = offset + rows.length;
    if (
      rows.length === 0 ||
      rows.length < CAMPAIGNS_PAGE_SIZE ||
      (total !== undefined && read >= total)
    ) {
      break;
    }
  }
  return [...campaigns.values()];
}

const appDetailsSchema = z.object({
  result: z
    .object({
      id: appleIdSchema.optional(),
      appName: z.string().nullable().optional(),
    })
    .loose(),
});

/**
 * The App Store name of a promoted app (`GET /v1/apps/{adamId}`), or
 * undefined when Apple does not name it (404, refused, unexpected shape):
 * a missing name never fails a discovery. TO BE CONFIRMED by #370: that
 * the call is ad-account scoped and answers for every promoted app.
 */
export async function appName(
  client: AppleAdsClient,
  adAccountId: string,
  appId: string,
): Promise<string | undefined> {
  try {
    const parsed = appDetailsSchema.safeParse(
      await client.json(`/v1/apps/${appId}`, { adAccountId }),
    );
    return parsed.success
      ? parsed.data.result.appName?.trim() || undefined
      : undefined;
  } catch (error) {
    if (
      error instanceof AppleAdsApiError &&
      (error.status === 400 || error.status === 403 || error.status === 404)
    ) {
      return undefined;
    }
    throw error;
  }
}
