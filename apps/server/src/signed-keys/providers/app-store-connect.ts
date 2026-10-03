import type { SignedKeyProviderDefinition } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID = /^[A-Z0-9]{10}$/;

/** Where team keys are created and revoked. */
export const APP_STORE_CONNECT_KEYS_URL =
  "https://appstoreconnect.apple.com/access/integrations/api";

/**
 * App Store Connect (ADR 0014): a team API key (issuer ID, key ID and the
 * `.p8` private key) signed into ES256 JWTs with `aud: appstoreconnect-v1`.
 * A token lives 10 minutes (`iat` now − 60 s, `exp` now + 9 min), under
 * Apple's 20-minute ceiling. The vendor number is not a secret: it is
 * connection config, which the probes receive.
 *
 * The validation probes against the API (`GET /v1/apps?limit=1` and the
 * sales report of the configured vendor number) belong to #171 and plug
 * into `probes`.
 */
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
    {
      key: "keyId",
      label: "Key ID",
      description: "The 10-character Key ID in the row of your team key.",
      input: "text",
      secret: false,
      placeholder: "2X9R4HXF34",
      maxBytes: 32,
      validate: (value) =>
        KEY_ID.test(value)
          ? null
          : "Key ID must be 10 uppercase letters and digits, such as 2X9R4HXF34. Copy it from the row of your team key.",
    },
    {
      key: "privateKey",
      label: "Private key",
      description:
        "The AuthKey_<Key ID>.p8 file you downloaded when you created the key. Apple lets you download it only once.",
      input: "file",
      secret: true,
      maxBytes: 4096,
      privateKey: true,
    },
  ],
  token: (credentials) => ({
    kid: credentials.keyId!,
    claims: { iss: credentials.issuerId!, aud: "appstoreconnect-v1" },
  }),
  lifetime: { issuedBeforeSeconds: 60, expiresInSeconds: 9 * 60 },
  serverDomains: ["api.appstoreconnect.apple.com"],
  setup: {
    steps: [
      "Sign in to App Store Connect as the Account Holder or an Admin and open Users and Access → Integrations → App Store Connect API.",
      "Under Team Keys, generate a key with the Sales role (Finance also works; Admin works but grants more than netrics needs). Individual keys cannot read sales reports.",
      "Download the .p8 file (Apple offers it only once), and copy the Issuer ID and the Key ID.",
      "Your vendor number is in Payments and Financial Reports, under your legal entity name.",
    ],
    url: APP_STORE_CONNECT_KEYS_URL,
  },
  // #171 adds the apps and sales-report probes.
  probes: [],
  authFailure: {
    unauthorized:
      "App Store Connect refused the key: it was revoked, or the issuer ID, key ID and private key do not belong together. Upload a new App Store Connect key.",
    forbidden:
      "App Store Connect refused access: the key's role was changed or access was removed. This key needs the Sales or Finance role. Upload a new App Store Connect key.",
  },
};
