import { authProof } from "@/lib/session";
import { authHeaders } from "./authHeaders";
const API = ""; // relative; /api is proxied in dev or same-origin in prod

export interface Dispute {
  offerId: string;
  openedBy: "buyer" | "seller";
  reason: string;
  openedByWallet: string;
  status: "OPEN" | "UNDER_REVIEW" | "CLOSED";
  triggeredByTimeout?: boolean;
  /** Request key for the deposit (fund) transaction by seller. Set when seller deposits. */
  fundTxRequestKey?: string | null;
  /** Request key for the release or refund transaction by arbiter. Set when arbiter releases or refunds. */
  releaseRefundTxRequestKey?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DisputeListItem extends Dispute {
  id: number;
}

export interface DisputeAction {
  id: number;
  offerId: string;
  actionType: "request_info" | "under_review" | "resolved";
  byWallet: string;
  payload: { message?: string; at?: string } | null;
  createdAt: string;
}

export async function listDisputes(status?: "OPEN" | "UNDER_REVIEW" | "CLOSED"): Promise<DisputeListItem[]> {
  const url = new URL(`${API}/api/disputes`, window.location.origin);
  if (status) url.searchParams.set("status", status);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
  return res.json();
}

export async function getDisputeActions(offerId: string): Promise<DisputeAction[]> {
  const res = await fetch(`${API}/api/disputes/${encodeURIComponent(offerId)}/actions`);
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
  return res.json();
}

export async function setDisputeUnderReview(params: {
  offerId: string;
  wallet: string;
  publicKey: string;
  signedCmd: unknown;
}): Promise<{ success: boolean; status: string }> {
  const res = await fetch(`${API}/api/disputes/${encodeURIComponent(params.offerId)}/review`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.reason || e.error || "Failed to set under review");
  }
  return res.json();
}

export async function requestDisputeInfo(params: {
  offerId: string;
  message?: string;
  wallet: string;
  publicKey: string;
  signedCmd: unknown;
}): Promise<{ success: boolean }> {
  const res = await fetch(`${API}/api/disputes/${encodeURIComponent(params.offerId)}/request-info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.reason || e.error || "Failed to request info");
  }
  return res.json();
}

export interface Evidence {
  _id?: string;
  offerId: string;
  submittedBy: string;
  explanation: string;
  files: Array<{
    filename: string;
    originalName: string;
    mimeType: string;
    size: number;
    url: string;
  }>;
  submittedAt: string;
}

export async function openDispute(params: {
  offerId: string;
  openedBy: "buyer" | "seller";
  reason: string;
  wallet: string;
  publicKey: string;
  signedCmd: unknown;
}): Promise<Dispute> {
  const res = await fetch(`${API}/api/disputes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.reason || e.error || "Failed to open dispute");
  }
  return res.json();
}

export async function getDispute(offerId: string): Promise<Dispute | null> {
  const res = await fetch(`${API}/api/disputes/${encodeURIComponent(offerId)}`);
  // Prefer 200 + null (no dispute). Legacy: 404 meant the same.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
  const data = (await res.json()) as Dispute | null;
  return data ?? null;
}

export async function submitEvidence(params: {
  offerId: string;
  files: File[];
  explanation: string;
  wallet: string;
  publicKey: string;
  signedCmd: unknown;
}): Promise<Evidence> {
  const { files, explanation, wallet, publicKey, signedCmd, offerId } = params;
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  form.append("explanation", explanation);
  form.append("wallet", wallet);
  form.append("publicKey", publicKey);
  form.append("signedCmd", typeof signedCmd === "string" ? signedCmd : JSON.stringify(signedCmd));
  
  const res = await fetch(`${API}/api/disputes/${encodeURIComponent(offerId)}/evidence`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.reason || e.error || "Failed to submit evidence");
  }
  return res.json();
}

/** Who is asking: disputes are private to the two sides and the arbiter (checked on the server). */
export type DisputeReader = { account: string; publicKey: string };
async function readerHeaders(who: DisputeReader) {
  return authHeaders(who.account, who.publicKey, await authProof(who.account, who.publicKey));
}

export async function getEvidence(offerId: string, who: DisputeReader): Promise<Evidence[]> {
  const url = new URL(`${API}/api/disputes/${encodeURIComponent(offerId)}/evidence`, window.location.origin);
  const res = await fetch(url.toString(), { headers: await readerHeaders(who) });
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
  return res.json();
}

export interface DisputeMessage {
  _id?: string;
  offerId: string;
  from: string;
  message: string;
  createdAt: string;
}

export async function sendMessage(params: {
  offerId: string;
  message: string;
  wallet: string;
  publicKey: string;
  signedCmd: unknown;
}): Promise<DisputeMessage> {
  const res = await fetch(`${API}/api/disputes/${encodeURIComponent(params.offerId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.reason || e.error || "Failed to send message");
  }
  return res.json();
}

export async function getMessages(offerId: string, who: DisputeReader): Promise<DisputeMessage[]> {
  const url = new URL(`${API}/api/disputes/${encodeURIComponent(offerId)}/messages`, window.location.origin);
  const res = await fetch(url.toString(), { headers: await readerHeaders(who) });
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
  return res.json();
}

export async function closeDispute(params: {
  offerId: string;
  wallet: string;
  publicKey: string;
  signedCmd: unknown;
}): Promise<{ success: boolean; status: string }> {
  const res = await fetch(`${API}/api/disputes/${encodeURIComponent(params.offerId)}/close`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.reason || e.error || "Failed to close dispute");
  }
  return res.json();
}

/** Save fund (deposit) transaction request key for an offer. Call after seller deposits. */
export async function putFundTxRequestKey(params: {
  offerId: string;
  requestKey: string;
  wallet: string;
  publicKey: string;
  signedCmd: unknown;
}): Promise<{ ok: boolean; offerId: string }> {
  const res = await fetch(`${API}/api/offers/${encodeURIComponent(params.offerId)}/fund-tx`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      offerId: params.offerId,
      requestKey: params.requestKey,
      wallet: params.wallet,
      publicKey: params.publicKey,
      signedCmd: params.signedCmd,
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.reason || e.error || "Failed to save fund tx");
  }
  return res.json();
}

/** Save release/refund transaction request key for a dispute. Call after arbiter releases or refunds. */
export async function putReleaseRefundTxRequestKey(params: {
  offerId: string;
  requestKey: string;
  wallet: string;
  publicKey: string;
  signedCmd: unknown;
}): Promise<{ ok: boolean; offerId: string }> {
  const res = await fetch(`${API}/api/disputes/${encodeURIComponent(params.offerId)}/release-refund-tx`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestKey: params.requestKey,
      wallet: params.wallet,
      publicKey: params.publicKey,
      signedCmd: params.signedCmd,
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.reason || e.error || "Failed to save release/refund tx");
  }
  return res.json();
}
