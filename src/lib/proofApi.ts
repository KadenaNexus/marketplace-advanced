import { authHeaders } from "./authHeaders";
/** Proof of payment the buyer adds with Mark as Paid. See server/proofs.js. */

export interface Proof { reference: string | null; fileUrl: string | null; fileName: string | null; at: string }
type Auth = { wallet: string; publicKey: string; signedCmd: unknown };
const proof = (s: unknown) => (typeof s === "string" ? s : JSON.stringify(s));

export async function getProofs(offerId: string, a: Auth): Promise<Proof[]> {
  const r = await fetch(`/api/offers/${encodeURIComponent(offerId)}/proof`, { headers: authHeaders(a.wallet, a.publicKey, a.signedCmd) });
  if (r.status === 403 || r.status === 404) return [];
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not load the proof of payment");
  return r.json();
}

export async function addProof(offerId: string, input: { reference?: string; file?: File | null }, a: Auth): Promise<void> {
  const fd = new FormData();
  fd.append("wallet", a.wallet);
  fd.append("publicKey", a.publicKey);
  fd.append("signedCmd", proof(a.signedCmd));
  if (input.reference) fd.append("reference", input.reference);
  if (input.file) fd.append("file", input.file);
  // multipart goes straight to the API server in development (the dev proxy can break it)
  const base = import.meta.env?.DEV ? (import.meta.env.VITE_PROFILE_API || "http://127.0.0.1:3001") : "";
  const r = await fetch(`${base}/api/offers/${encodeURIComponent(offerId)}/proof`, { method: "POST", body: fd });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not upload the proof");
}
