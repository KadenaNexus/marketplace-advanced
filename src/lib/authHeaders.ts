/**
 * Proof of ownership as request headers (read by server/authHeaders.js), so a signed proof or session token is
 * never part of an address, where browsers, proxies and server logs keep it.
 */
export function authHeaders(wallet: string, publicKey: string, signedCmd: unknown): Record<string, string> {
  return {
    "X-Nexus-Wallet": wallet,
    "X-Nexus-Key": publicKey,
    "X-Nexus-Auth": typeof signedCmd === "string" ? signedCmd : JSON.stringify(signedCmd),
  };
}
