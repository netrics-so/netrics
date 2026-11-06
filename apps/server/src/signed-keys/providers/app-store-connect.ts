import {
  AppStoreConnectApiError,
  AppStoreConnectRateBudgetError,
  createAppStoreConnectClient,
  probeApps,
  probeCustomerReviews,
  probeReviewsKeyNotAdmin,
  probeSalesReport,
  reviewsProbeApp,
} from "@netrics/connectors";

import type {
  SignedKeyAdditionalKey,
  SignedKeyField,
  SignedKeyProbe,
  SignedKeyProbeContext,
  SignedKeyProbeResult,
  SignedKeyProviderDefinition,
} from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID = /^[A-Z0-9]{10}$/;

/** Where team keys are created and revoked. */
export const APP_STORE_CONNECT_KEYS_URL =
  "https://appstoreconnect.apple.com/access/integrations/api";

/** Payments and Financial Reports, which shows the vendor number. */
export const APP_STORE_CONNECT_PAYMENTS_URL =
  "https://appstoreconnect.apple.com/itc/payments_and_financial_reports";

/**
 * App Store Connect (ADR 0014): a team API key (issuer ID, key ID and the
 * `.p8` private key) signed into ES256 JWTs with `aud: appstoreconnect-v1`.
 * A token lives 10 minutes (`iat` now − 60 s, `exp` now + 9 min), under
 * Apple's 20-minute ceiling. The vendor number is not a secret: it is
 * connection config, which the probes receive.
 *
 * The validation probes (#171) are the connector's own key check, run here
 * before anything is stored: `GET /v1/apps?limit=1` (a 401 means the three
 * values do not belong together, or the key was revoked), then the daily
 * sales report of the configured vendor number (a 403 names the missing
 * role, a vendor error the vendor number; a 404 for a day without sales
 * passes).
 */
export const RATE_LIMITED_MESSAGE =
  "App Store Connect's hourly request limit for this key is used up. Try again in an hour.";

/**
 * A probe with one freshly signed token. A rate limit (429, or a nearly
 * used-up hourly budget) gets its own message; other thrown failures (5xx,
 * network) become the host's generic "could not be reached".
 */
function probe(
  name: string,
  run: (
    client: ReturnType<typeof createAppStoreConnectClient>,
    context: SignedKeyProbeContext,
  ) => Promise<SignedKeyProbeResult>,
): SignedKeyProbe {
  return {
    name,
    async run(context) {
      const client = createAppStoreConnectClient(
        context.fetch,
        context.accessToken(),
      );
      try {
        return await run(client, context);
      } catch (error) {
        if (
          error instanceof AppStoreConnectRateBudgetError ||
          (error instanceof AppStoreConnectApiError && error.status === 429)
        ) {
          return { ok: false, message: RATE_LIMITED_MESSAGE };
        }
        throw error;
      }
    },
  };
}

/** The key, role and vendor-number probes, in order (#171). */
export const appStoreConnectProbes: readonly SignedKeyProbe[] = [
  probe("apps", (client) => probeApps(client)),
  probe("sales-report", (client, context) =>
    probeSalesReport(client, context.config, Date.now()),
  ),
];

const keyIdField = (description: string): SignedKeyField => ({
  key: "keyId",
  label: "Key ID",
  description,
  input: "text",
  secret: false,
  placeholder: "2X9R4HXF34",
  maxBytes: 32,
  validate: (value) =>
    KEY_ID.test(value)
      ? null
      : "Key ID must be 10 uppercase letters and digits, such as 2X9R4HXF34. Copy it from the row of your team key.",
});

const privateKeyField = (description: string): SignedKeyField => ({
  key: "privateKey",
  label: "Private key",
  description,
  input: "file",
  secret: true,
  maxBytes: 4096,
  privateKey: true,
});

/**
 * The reviews key's probes (#190): it reads the customer reviews of an app
 * of the connection (401: not this team's key, or revoked; 403: the role
 * cannot read reviews), and it must not read sales reports too, which only
 * an Admin key does (netrics never stores an Admin key).
 */
export const appStoreConnectReviewsProbes: readonly SignedKeyProbe[] = [
  probe("customer-reviews", async (client, context) => {
    const appId = await reviewsProbeApp(client, context.config);
    if (appId === undefined) {
      // A team without apps has no reviews; the role is checked next.
      return { ok: true };
    }
    if (typeof appId !== "string") {
      return appId;
    }
    return probeCustomerReviews(client, appId);
  }),
  probe("reviews-not-admin", (client, context) =>
    probeReviewsKeyNotAdmin(client, context.config, Date.now()),
  ),
];

/**
 * The optional second key for ratings and reviews (ADR 0014 decision 2,
 * #190): a team key of the same issuer with the Customer Support role.
 * Stored in the envelope as `reviews: { keyId, privateKey }`; the connector
 * receives its token as `credentials.reviewsAccessToken`.
 */
export const appStoreConnectReviewsKey: SignedKeyAdditionalKey = {
  id: "reviews",
  name: "Customer Support key",
  tokenField: "reviewsAccessToken",
  fields: [
    keyIdField(
      "The 10-character Key ID in the row of the Customer Support key (also in its file name, AuthKey_<Key ID>.p8).",
    ),
    privateKeyField(
      "The AuthKey_<Key ID>.p8 file of the Customer Support key. Apple lets you download it only once.",
    ),
  ],
  probes: appStoreConnectReviewsProbes,
};

export const appStoreConnectProvider: SignedKeyProviderDefinition = {
  id: "app-store-connect",
  name: "App Store Connect",
  fields: [
    {
      key: "issuerId",
      label: "Issuer ID",
      description:
        "Shown above the list of team keys under Users and Access → Integrations → App Store Connect API.",
      input: "text",
      secret: false,
      placeholder: "57246542-96fe-1a63-e053-0824d011072a",
      maxBytes: 64,
      validate: (value) =>
        UUID.test(value)
          ? null
          : "Issuer ID must be a UUID such as 57246542-96fe-1a63-e053-0824d011072a. Copy it from above the list of team keys.",
    },
    keyIdField("The 10-character Key ID in the row of your team key."),
    privateKeyField(
      "The AuthKey_<Key ID>.p8 file you downloaded when you created the key. Apple lets you download it only once.",
    ),
  ],
  token: (credentials) => ({
    kid: credentials.keyId!,
    claims: { iss: credentials.issuerId!, aud: "appstoreconnect-v1" },
  }),
  lifetime: { issuedBeforeSeconds: 60, expiresInSeconds: 9 * 60 },
  serverDomains: ["api.appstoreconnect.apple.com"],
  setup: {
    steps: [
      "Sign in to App Store Connect as the Account Holder or an Admin and open Users and Access → Integrations → App Store Connect API. The first time, the Account Holder has to request API access there.",
      "Under Team Keys, generate a key named “netrics” with the Sales role. Finance also works; Admin works too, but grants far more than netrics needs. Individual keys cannot read sales reports.",
      "Download the .p8 file right away (Apple offers it only once). Copy the Key ID from the key's row and the Issuer ID shown above the list.",
      "Find your vendor number in Payments and Financial Reports, under your legal entity name.",
      "Enter the values below. netrics checks the key with Apple before it stores anything.",
    ],
    url: APP_STORE_CONNECT_KEYS_URL,
    links: [
      {
        step: 0,
        label: "Open App Store Connect API keys",
        url: APP_STORE_CONNECT_KEYS_URL,
      },
      {
        step: 3,
        label: "Open Payments and Financial Reports",
        url: APP_STORE_CONNECT_PAYMENTS_URL,
      },
    ],
  },
  probes: appStoreConnectProbes,
  additionalKeys: [appStoreConnectReviewsKey],
  authFailure: {
    unauthorized:
      "App Store Connect refused the key: it was revoked, or the issuer ID, key ID and private key do not belong together. Upload a new App Store Connect key.",
    forbidden:
      "App Store Connect refused access: the key's role was changed or access was removed. This key needs the Sales or Finance role. Upload a new App Store Connect key.",
  },
};
