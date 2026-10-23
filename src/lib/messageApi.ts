import { authHeaders } from "./authHeaders";
// Relative "" is proxied in dev. Vite proxy can break multipart/form-data; for attachments use direct backend URL in dev.
const API = "";
const API_DIRECT =
  typeof import.meta !== "undefined" && import.meta.env?.DEV
    ? (import.meta.env.VITE_PROFILE_API || "http://127.0.0.1:3001")
    : "";

export interface UserMessage {
  id: number;
  from: string;
  to: string;
  message: string;
  createdAt: string;
  readAt: string | null;
  contextOfferId?: string | null; // Optional reference to offer that triggered conversation
  attachmentUrl?: string | null;
  attachmentName?: string | null;
}

export interface SendMessageParams {
  toWallet: string;
  message: string;
  wallet: string;
  publicKey: string;
  signedCmd: unknown;
  contextOfferId?: string; // Optional: offer that triggered this message
  attachment?: File; // Optional file (images or PDF, max 5MB)
}

export async function sendMessage(params: SendMessageParams): Promise<UserMessage> {
  const hasFile = !!params.attachment;
  if (hasFile) {
    const form = new FormData();
    form.append("toWallet", params.toWallet);
    form.append("message", params.message ?? "");
    form.append("wallet", params.wallet);
    form.append("publicKey", params.publicKey);
    form.append("signedCmd", typeof params.signedCmd === "string" ? params.signedCmd : JSON.stringify(params.signedCmd));
    if (params.contextOfferId) form.append("contextOfferId", params.contextOfferId);
    form.append("attachment", params.attachment);
    const base = API_DIRECT || API;
    const url = base ? `${base.replace(/\/$/, "")}/api/messages` : `${API}/api/messages`;
    const res = await fetch(url, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({ error: res.statusText }));
      const msg = e.reason || e.error || (res.status === 404 ? "Chat server not available. Run 'npm run dev:server' in another terminal for profile and chat." : "Failed to send message");
      throw new Error(msg);
    }
    return res.json();
  }
  const res = await fetch(`${API}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: params.message,
      toWallet: params.toWallet,
      wallet: params.wallet,
      publicKey: params.publicKey,
      signedCmd: params.signedCmd,
      contextOfferId: params.contextOfferId,
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    const msg = e.reason || e.error || (res.status === 404 ? "Chat server not available. Run 'npm run dev:server' in another terminal for profile and chat." : "Failed to send message");
    throw new Error(msg);
  }
  return res.json();
}

export interface GetMessagesParams {
  otherWallet: string;
  wallet: string;
  publicKey: string;
  signedCmd: unknown;
}

export async function getMessages(params: GetMessagesParams): Promise<UserMessage[]> {
  const { otherWallet, wallet, publicKey, signedCmd } = params;
  const url = `${API}/api/messages/${encodeURIComponent(otherWallet)}`;
  const res = await fetch(url, { headers: authHeaders(wallet, publicKey, signedCmd) });
  if (!res.ok) {
    const errorText = await res.text().catch(() => res.statusText);
    console.error("[getMessages] Error:", res.status, errorText);
    const msg = res.status === 404
      ? "Chat server not available. Run 'npm run dev:server' in another terminal for profile and chat."
      : (errorText || `Failed to fetch messages: ${res.status}`);
    throw new Error(msg);
  }
  return res.json();
}

export async function markMessageAsRead(
  messageId: number,
  wallet: string,
  publicKey: string,
  signedCmd: unknown
): Promise<{ id: number; readAt: string }> {
  const res = await fetch(
    `${API}/api/messages/${messageId}/read`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, publicKey, signedCmd }),
    }
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.reason || e.error || "Failed to mark message as read");
  }
  return res.json();
}

export interface GetUnreadCountParams {
  wallet: string;
  publicKey: string;
  signedCmd: unknown;
}

export async function getUnreadCount(params: GetUnreadCountParams): Promise<{ unreadCount: number }> {
  const { wallet, publicKey, signedCmd } = params;
  const res = await fetch(`${API}/api/messages/unread-count`, { headers: authHeaders(wallet, publicKey, signedCmd) });
  if (!res.ok) {
    throw new Error(await res.text().catch(() => res.statusText));
  }
  return res.json();
}

export interface OfferThread {
  /** The other person in the conversation */
  wallet: string;
  lastAt: string;
  unread: number;
}

/** For an offer's creator: who has written about this offer (newest first). */
export async function getOfferThreads(params: { offerId: string; wallet: string; publicKey: string; signedCmd: unknown }): Promise<OfferThread[]> {
  const res = await fetch(`${API}/api/messages/offer/${encodeURIComponent(params.offerId)}/threads`, { headers: authHeaders(params.wallet, params.publicKey, params.signedCmd) });
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || "Could not load conversations");
  return res.json();
}
