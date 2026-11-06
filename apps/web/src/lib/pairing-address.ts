/**
 * The pairing URL as a TV shows it: host and path, without scheme or
 * trailing slash ("netrics.tv", "app.example.com/devices/approve"). The
 * tvOS app words it the same way (NetricsKit PairingAddress).
 */
export function pairingAddress(pairingUrl: string): string {
  let url: URL;
  try {
    url = new URL(pairingUrl);
  } catch {
    return pairingUrl;
  }
  return `${url.host}${url.pathname}`.replace(/\/+$/, "");
}
