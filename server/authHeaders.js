/**
 * Proof of ownership in request headers instead of the address.
 *
 * GET requests used to carry `wallet`, `publicKey` and `signedCmd` (a signed proof or a session token) in the query
 * string, where web server access logs keep them. The site now sends them as headers:
 *   X-Nexus-Wallet: k:…   X-Nexus-Key: <public key>   X-Nexus-Auth: <signedCmd as sent before>
 * This middleware copies them into req.query when the query does not have them, so every route keeps reading
 * req.query as before. Older clients that still use the query string keep working.
 */
export const AUTH_HEADERS = { wallet: "x-nexus-wallet", publicKey: "x-nexus-key", signedCmd: "x-nexus-auth" };
const MAX = 8192;

export function authHeadersToQuery(req, _res, next) {
  const q = req.query;
  if (q && typeof q === "object") {
    for (const [field, header] of Object.entries(AUTH_HEADERS)) {
      const v = req.get?.(header);
      if (typeof v === "string" && v.length > 0 && v.length <= MAX && q[field] === undefined) q[field] = v;
    }
  }
  next();
}
