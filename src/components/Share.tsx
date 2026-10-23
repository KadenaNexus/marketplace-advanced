import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ClipboardPaste, Copy, Link2, Loader2, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isPoolRef, poolShareText, refFromLink, shareTargets, shareUrl, tradeShareText } from "@/lib/share";
import { readPool, readTrade } from "@/lib/v11";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export interface ShareItem { ref: string; title: string; text: string }
const SHARE_EVENT = "nexus-share";

/** Open the share sheet for a pool or trade from anywhere (a button, a toast action). */
export function openShare(item: ShareItem) {
  window.dispatchEvent(new CustomEvent<ShareItem>(SHARE_EVENT, { detail: item }));
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* older web views */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

/**
 * Mounted once (App). Tries the phone's own share sheet first (it lists WhatsApp, Telegram, X…); where there is
 * none, as in some wallet browsers, or it fails, shows our sheet: the link with Copy, and Telegram, WhatsApp, X.
 */
export function ShareHost() {
  const [item, setItem] = useState<ShareItem | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const on = async (ev: Event) => {
      const it = (ev as CustomEvent<ShareItem>).detail;
      if (!it?.ref) return;
      const url = shareUrl(it.ref);
      const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
      const phone = window.matchMedia?.("(pointer: coarse)").matches ?? false;
      if (phone && typeof nav.share === "function") {
        try { await nav.share({ title: it.title, text: it.text, url }); return; }
        catch (e) { if ((e as { name?: string })?.name === "AbortError") return; /* not allowed here: our sheet */ }
      }
      setCopied(false);
      setItem(it);
    };
    window.addEventListener(SHARE_EVENT, on);
    return () => window.removeEventListener(SHARE_EVENT, on);
  }, []);
  if (!item) return null;
  const url = shareUrl(item.ref);
  const t = shareTargets(url, item.text);
  const open = (href: string) => { window.open(href, "_blank", "noopener,noreferrer"); };
  return (
    <Dialog open={!!item} onOpenChange={(o) => { if (!o) setItem(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-xl"><Share2 className="h-5 w-5 text-primary" />Share</DialogTitle>
          <DialogDescription>{item.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg bg-muted p-2.5">
            <span className="min-w-0 flex-1 break-all font-mono text-xs">{url}</span>
            <Button type="button" size="sm" variant="outline" className="h-9 shrink-0 gap-1.5"
              onClick={async () => { const ok = await copyText(`${item.text} ${url}`); setCopied(ok); if (ok) toast.success("Link copied"); else toast.error("Could not copy: select the link and copy it"); }}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Button type="button" variant="outline" className="h-12" onClick={() => open(t.telegram)}>Telegram</Button>
            <Button type="button" variant="outline" className="h-12" onClick={() => open(t.whatsapp)}>WhatsApp</Button>
            <Button type="button" variant="outline" className="h-12" onClick={() => open(t.x)}>X</Button>
          </div>
          <p className="text-xs text-muted-foreground">The link opens this {isPoolRef(item.ref) ? "offer" : "trade"} in the Marketplace. People without Linx Wallet are shown how to get it.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A Share button for a pool or a trade. */
export function ShareButton({ item, label = "Share", iconOnly = false, className, variant = "outline" }: {
  item: ShareItem | null; label?: string; iconOnly?: boolean; className?: string; variant?: "outline" | "ghost" | "secondary";
}) {
  if (!item) return null;
  return (
    <Button type="button" variant={variant} className={cn(iconOnly ? "h-12 w-12 shrink-0 p-0" : "h-10 gap-2", className)}
      aria-label={iconOnly ? `Share: ${item.title}` : undefined} title={iconOnly ? "Share" : undefined}
      onClick={(e) => { e.stopPropagation(); openShare(item); }}>
      <Share2 className="h-4 w-4" />{!iconOnly && label}
    </Button>
  );
}

/** Share item for a pool (what the card shows). */
export const poolShareItem = (p: Parameters<typeof poolShareText>[0] & { poolId: string }): ShareItem => ({ ref: p.poolId, ...poolShareText(p) });
/** Share item for a trade. */
export const tradeShareItem = (t: Parameters<typeof tradeShareText>[0] & { tradeId: string }): ShareItem => ({ ref: t.tradeId, ...tradeShareText(t) });

/**
 * "Open a link": inside Linx a shared link from Telegram or WhatsApp opens in the phone's browser, not in the
 * wallet. Copy it there, paste it here, and the pool or trade opens.
 */
export function OpenLinkButton({ className }: { className?: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const ref = refFromLink(value);
  const go = (r: string) => { setOpen(false); setValue(""); navigate(`/?offer=${encodeURIComponent(r)}`); };
  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setValue(t);
      const r = refFromLink(t);
      if (r) go(r); else toast.error("That isn't a Marketplace link");
    } catch { toast.info("Long-press the box and choose Paste"); }
  };
  return (
    <>
      <Button type="button" variant="ghost" size="sm" className={cn("h-10 gap-2", className)} onClick={() => setOpen(true)}>
        <Link2 className="h-4 w-4" />Open a link
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Open a shared link</DialogTitle>
            <DialogDescription>Someone sent you a link to an offer or a trade? Paste it here to open it.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Button type="button" className="h-12 w-full gap-2" onClick={() => void paste()}><ClipboardPaste className="h-4 w-4" />Paste and open</Button>
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://marketplace.kadena.ws/s/…" className="h-11 font-mono text-sm" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="Shared link" />
            <Button type="button" variant="outline" className="h-11 w-full" disabled={!ref} onClick={() => ref && go(ref)}>Open</Button>
            {value && !ref && <p className="text-sm text-destructive">That isn't a Marketplace offer or trade link.</p>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * On the "Marketplace is in Linx" screen: what the link someone tapped points to, read from the chain, and the link
 * to copy and paste inside Linx (Open a link).
 */
export function SharedPreview({ refId }: { refId: string }) {
  const [state, setState] = useState<{ loading: boolean; title?: string; text?: string; gone?: boolean; closed?: boolean }>({ loading: true });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    (isPoolRef(refId) ? readPool(refId).then((p) => (p ? poolShareText(p) : null)) : readTrade(refId).then((t) => (t ? tradeShareText(t) : null)))
      .then((x) => { if (live) setState(x ? { loading: false, title: x.title, text: x.text, closed: / is closed$/.test(x.title) } : { loading: false, gone: true }); })
      .catch(() => { if (live) setState({ loading: false }); });
    return () => { live = false; };
  }, [refId]);
  const url = shareUrl(refId);
  return (
    <section className="space-y-3 rounded-2xl border-2 border-primary/40 bg-primary/5 p-4" aria-label="Shared with you">
      <p className="text-xs font-semibold uppercase tracking-wide text-primary">Shared with you</p>
      {state.loading ? <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        : state.gone ? <p className="font-semibold">This offer or trade was not found.</p>
        : <p className="font-display text-xl font-bold">{state.title ?? "An offer on Kadena P2P Marketplace"}</p>}
      {state.gone || state.closed ? (
        <p className="text-sm text-muted-foreground">See what's open now: open the Marketplace in Linx (steps below).</p>
      ) : (<>
      <p className="text-sm text-muted-foreground">To open it: copy the link, open the Marketplace in Linx (steps below), tap <b>Open a link</b> and paste it.</p>
      <Button type="button" className="h-12 w-full gap-2 sm:w-auto" onClick={async () => { const ok = await copyText(url); setCopied(ok); if (ok) toast.success("Link copied"); }}>
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? "Link copied" : "Copy the link"}
      </Button>
      </>)}
    </section>
  );
}
