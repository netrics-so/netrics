// Fixed English messages of the custom-api connector. The domain catalog
// (`providerMessages.customApi`) translates them by exact text, so they are
// whole sentences without interpolation.
export const CUSTOM_API_MESSAGES = {
  unauthorized:
    "The API refused the credentials (HTTP 401). Enter a new key, token or password for this connection, or reconnect it.",
  forbidden:
    "The API denied access (HTTP 403). Check that these credentials may read the endpoints of this custom API.",
  hostChanged:
    "This connection's credentials were entered for another API host. Enter them again for the connection's environment.",
  notJson:
    "The API did not answer with JSON. Check the base URL and the request path.",
  recordsNotList:
    "The record path does not point to a list or an object in the response. Choose the records again in the definition.",
  nextUrlOffHost:
    "The API's next page link points to another host. netrics only follows next page links on the API host.",
  pageLimit:
    "The run stopped after 200 pages, the most one run reads. The data so far is kept; the next run continues.",
  recordLimit:
    "The run stopped after 100,000 records, the most one run reads. The data so far is kept; the next run continues.",
  durationLimit:
    "The run stopped after 30 minutes, the longest one run takes. The data so far is kept; the next run continues.",
  tokenRefused:
    "The token endpoint refused the client ID or client secret. Check both values and enter them again.",
} as const;

export type CustomApiMessage =
  (typeof CUSTOM_API_MESSAGES)[keyof typeof CUSTOM_API_MESSAGES];
