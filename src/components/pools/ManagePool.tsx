import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useWallet } from "@/hooks/useWallet";
import { useRefreshV11, useV11Config } from "@/hooks/useV11";
import { useAutoRelease } from "@/hooks/useAutoRelease";
import { watchedText } from "@/lib/autoReleaseApi";
import { appChainShortfall, fetchTradeTxs, getTxExplorerUrl } from "@/lib/kadena";
import { GAS_V11, buildClosePoolTx, buildTopUpTx, buildUpdatePoolTx, buildWithdrawTx, gasKda, poolVault, type Trade } from "@/lib/v11";
import { exactPay, sendV11 } from "@/lib/v11ui";
import { getPoolPayout, putPoolDetails, type PoolListing } from "@/lib/poolsApi";
import { authProof } from "@/lib/session";
import { EXPIRY_DAYS, PAY_WINDOWS, addressProblem, chainLabel, isGiveawayPool, isInstant, isStableCurrency, networkLabel, networksFor } from "@/lib/markets";
import { TradeCode } from "../TradeCode";
import { EscrowStatus } from "../EscrowStatus";
import { ConfirmDialog } from "../TradeSafety";
import type { EscrowState } from "@/lib/kadena";
import { formatFiat, cn } from "@/lib/utils";
import { kdaAmount, isExpired } from "./PoolCard";
import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, Loader2, Pencil, Radar, XCircle } from "lucide-react";
import { ShareButton, poolShareItem } from "../Share";
import { toast } from "sonner";

const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : NaN; };
const ACTIVE = new Set(["FUNDED", "PAID", "DISPUTED"]);

interface ManagePoolProps {
  pool: PoolListing | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** This pool's trades, newest first */
  trades: Trade[];
  onOpenTrade: (tradeId: string) => void;
}

/** The creator's view of a pool: top-up, withdraw, edit, close, and its trades. */
export function ManagePool({ pool: p, open, onOpenChange, trades, onOpenTrade }: ManagePoolProps) {
  const { account } = useWallet();
  const refresh = useRefreshV11();
  const [tab, setTab] = useState<"trades" | "history" | "topup" | "withdraw" | "edit">("trades");
  const [amount, setAmount] = useState("");
  const [min, setMin] = useState(""); const [max, setMax] = useState(""); const [price, setPrice] = useState("");
  const [payWindow, setPayWindow] = useState(1800); const [expiryDays, setExpiryDays] = useState(0);
  const [networks, setNetworks] = useState<string[]>([]);
  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [autoOn, setAutoOn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const auto = useAutoRelease();
  const { data: cfg, isPlaceholderData: cfgLoading } = useV11Config();

  const free = !!p && isGiveawayPool(p);
  const instant = !!p && isInstant(p);
  const stable = !!p && isStableCurrency(p.currency);
  const closed = p?.state === "CLOSED";

  useEffect(() => {
    if (!open || !p) return;
    setTab("trades"); setAmount("");
    setMin(String(p.min)); setMax(String(p.max)); setPrice(String(p.price)); setPayWindow(p.payWindow);
    setExpiryDays(p.expiresAt ? Math.max(1, Math.round((Date.parse(p.expiresAt) - Date.now()) / 86400000)) : 0);
    setNetworks(p.networks); setNotes(p.notes); setAddresses({});
    if (account && stable && p.side === "SELL") {
      (async () => {
        try {
          const signedCmd = await authProof(account.account, account.publicKey);
          const payout = await getPoolPayout(p.poolId, { wallet: account.account, publicKey: account.publicKey, signedCmd });
          if (payout) setAddresses(payout);
        } catch { /* typed again */ }
      })();
    }
  }, [open, p, account, stable]);
  // the pool's own transactions (create, top-ups, withdrawals, edits, close), recorded by the server from each signed step
  const { data: poolTxs = [], isLoading: txsLoading } = useQuery({
    queryKey: ["trade-txs", p?.poolId], queryFn: () => fetchTradeTxs(p!.poolId), enabled: open && !!p && tab === "history", staleTime: 15 * 1000,
  });
  // its own effect: the platform's agent may load after the sheet opened, and must not reset the other fields
  useEffect(() => { if (open && p) setAutoOn(!!p.agent && p.agent === auto.agent); }, [open, p, auto.agent]);

  if (!p) return null;
  const open_ = trades.filter((t) => ACTIVE.has(t.state)).length;
  // auto-release: the switch shows when the platform runs its agent and the pool pays on a watched network
  const canAuto = stable && auto.available && networks.some((n) => auto.networks.includes(n));
  // the contract accepts only the current agent or none: an agent the platform no longer uses is dropped on save
  const agentToSave = canAuto ? (autoOn ? auto.agent : "") : cfgLoading || p.agent === (cfg?.agent ?? "") ? p.agent : "";

  const run = async (name: string, fn: () => Promise<void>) => {
    if (!account) return toast.error("Connect your wallet");
    setBusy(name);
    try { await fn(); refresh(); }
    catch (err) { toast.error(`${name} failed`, { description: err instanceof Error ? err.message : "Unknown error" }); }
    finally { setBusy(null); }
  };

  const topUp = () => run("Top-up", async () => {
    const n = num(amount);
    if (!(n > 0)) throw new Error("Enter an amount");
    // a SELL pool locks the KDA (plus gas); a BUY offer only raises the amount wanted and pays gas
    const s = await appChainShortfall(account!.account, p.side === "SELL" ? n : 0, p.chain, gasKda(GAS_V11)).catch(() => null);
    if (s) throw new Error(s.description);
    const vault = p.side === "SELL" ? await poolVault(p.poolId) : undefined;
    await sendV11(`Adding ${kdaAmount(n)} KDA to your pool`, () => buildTopUpTx(p.poolId, account!.account, account!.publicKey, n, p.side, vault));
    toast.success(`${kdaAmount(n)} KDA added`); setAmount(""); setTab("trades");
  });
  const withdraw = () => run("Withdraw", async () => {
    const n = num(amount);
    if (!(n > 0)) throw new Error("Enter an amount");
    if (n > p.available) throw new Error(`At most ${kdaAmount(p.available)} KDA (the unsold part)`);
    await sendV11(`Taking ${kdaAmount(n)} KDA out of your pool`, () => buildWithdrawTx(p.poolId, account!.account, account!.publicKey, n));
    toast.success(`${kdaAmount(n)} KDA back in your wallet`); setAmount(""); setTab("trades");
  });
  const save = () => run("Save", async () => {
    const mn = num(min), mx = num(max), pr = free ? 0 : num(price);
    if (!(mn > 0) || !(mx > 0) || mn > mx) throw new Error("Check the minimum and maximum");
    if (!free && !(pr > 0)) throw new Error("Enter the price");
    if (stable && p.side === "SELL") for (const n of networks) { const pb = addressProblem(n, addresses[n] ?? ""); if (pb) throw new Error(`${networkLabel(n)}: ${pb}`); }
    if (stable && networks.length === 0) throw new Error("Choose at least one network");
    const changed = mn !== p.min || mx !== p.max || pr !== p.price || payWindow !== p.payWindow || agentToSave !== p.agent || expiryDays !== (p.expiresAt ? Math.max(1, Math.round((Date.parse(p.expiresAt) - Date.now()) / 86400000)) : 0);
    if (changed) {
      const expiresAt = expiryDays > 0 ? new Date(Date.now() + expiryDays * 86400000).toISOString() : null;
      await sendV11("Updating your pool", () => buildUpdatePoolTx(p.poolId, account!.account, account!.publicKey, { min: mn, max: mx, price: pr, payWindow, expiresAt, agent: agentToSave }));
    }
    if (!free) {
      try {
        const signedCmd = await authProof(account!.account, account!.publicKey);
        const payout = p.side === "SELL" ? Object.fromEntries(networks.map((n) => [n, (addresses[n] ?? "").trim()])) : {};
        await putPoolDetails(p.poolId, { networks: stable ? networks : [], payout, notes: notes.trim() }, { wallet: account!.account, publicKey: account!.publicKey, signedCmd });
      } catch (err) {
        toast.warning("Saved on chain; the server could not save the payment details", { description: err instanceof Error ? err.message : undefined });
      }
    }
    toast.success("Pool updated"); setTab("trades");
  });
  const close = () => setConfirmClose(true);
  const doClose = () => {
    void run("Close", async () => {
      await sendV11("Closing your pool", () => buildClosePoolTx(p.poolId, account!.account, account!.publicKey));
      toast.success("Pool closed"); onOpenChange(false);
    });
  };

  type Tab = "trades" | "history" | "topup" | "withdraw" | "edit";
  const tabs: { id: Tab; label: string }[] = [
    { id: "trades", label: `Trades (${trades.length})` },
    { id: "history", label: "History" },
    ...(!closed ? [{ id: "topup" as Tab, label: "Top up" }, { id: "withdraw" as Tab, label: "Withdraw" }, { id: "edit" as Tab, label: "Edit" }] : []),
  ];

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <SheetContent side="bottom" className="mx-auto max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:rounded-2xl sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 sm:border">
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2 font-display text-xl">
            Your {free ? "giveaway" : p.side === "SELL" ? "sell pool" : "buy offer"} <TradeCode offerId={p.poolId} copy />
            {!closed && <ShareButton item={poolShareItem(p)} variant="ghost" className="ml-auto h-9 px-2" />}
          </SheetTitle>
          <SheetDescription>
            {kdaAmount(p.available)} KDA available · {kdaAmount(p.locked)} in trades · {p.takes} take{p.takes === 1 ? "" : "s"}
            {!free && <> · {formatFiat(p.price, p.currency)} {p.currency}/KDA</>}
            {closed ? " · Closed" : isExpired(p) ? " · Expired" : ""} · {chainLabel(p.chain)}
          </SheetDescription>
        </SheetHeader>

        <div role="tablist" className="mt-4 grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-muted p-1">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
              className={cn("h-10 rounded-lg text-sm font-medium", tab === t.id ? "bg-card shadow-sm" : "text-muted-foreground")}>{t.label}</button>
          ))}
        </div>

        <div className="mt-4 space-y-4">
          {tab === "trades" && (
            trades.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">Nobody has taken from this pool yet.</p> : (
              <ul className="space-y-2">
                {trades.map((t) => (
                  <li key={t.tradeId}>
                    <button type="button" onClick={() => onOpenTrade(t.tradeId)} className="flex w-full items-center justify-between gap-3 rounded-xl border border-border p-3 text-left hover:border-primary">
                      <span className="min-w-0">
                        <span className="block font-semibold">{kdaAmount(t.amount)} KDA{!free && <span className="font-normal text-muted-foreground"> for {instant ? formatFiat(t.payAmount, t.currency) : exactPay(t.payAmount)} {t.currency}</span>}</span>
                        <span className="block truncate text-xs text-muted-foreground">{p.side === "SELL" ? "Buyer" : "Seller"} {(p.side === "SELL" ? t.buyer : t.seller).slice(0, 10)}… · {t.fundedAt ? new Date(t.fundedAt).toLocaleString() : ""}</span>
                      </span>
                      <EscrowStatus state={t.state as EscrowState} />
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}

          {tab === "history" && (
            <PoolHistory createdAt={p.createdAt} txs={poolTxs} loading={txsLoading} trades={trades} free={free} sell={p.side === "SELL"} onOpenTrade={onOpenTrade} />
          )}

          {(tab === "topup" || tab === "withdraw") && (
            <div className="space-y-3">
              <Label htmlFor="manage-amount">{tab === "topup" ? "KDA to add" : "KDA to take out"}</Label>
              <Input id="manage-amount" type="number" inputMode="decimal" step="any" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-12 font-mono text-lg" />
              {tab === "withdraw" && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>Up to {kdaAmount(p.available)} KDA (the unsold part)</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => setAmount(String(p.available))}>Max</Button>
                </div>
              )}
              {tab === "topup" && <p className="text-sm text-muted-foreground">{p.side === "SELL" ? "Locked in the pool in one transaction." : "Raises how much you want to buy."}</p>}
              <Button className="h-12 w-full gap-2" disabled={!!busy} onClick={tab === "topup" ? topUp : withdraw}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : tab === "topup" ? <ArrowDownToLine className="h-4 w-4" /> : <ArrowUpFromLine className="h-4 w-4" />}
                {tab === "topup" ? "Add to the pool" : "Take out"}
              </Button>
            </div>
          )}

          {tab === "edit" && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1"><Label htmlFor="edit-min">Min per trade</Label><Input id="edit-min" type="number" inputMode="decimal" step="any" value={min} onChange={(e) => setMin(e.target.value)} className="h-11 font-mono" /></div>
                <div className="space-y-1"><Label htmlFor="edit-max">Max per trade</Label><Input id="edit-max" type="number" inputMode="decimal" step="any" value={max} onChange={(e) => setMax(e.target.value)} className="h-11 font-mono" /></div>
              </div>
              {!free && (
                <div className="space-y-1"><Label htmlFor="edit-price">Price per KDA ({p.currency})</Label><Input id="edit-price" type="number" inputMode="decimal" step="any" value={price} onChange={(e) => setPrice(e.target.value)} className="h-11 font-mono" /></div>
              )}
              {!free && !instant && (
                <div className="space-y-1">
                  <Label htmlFor="edit-window">Payment window</Label>
                  <Select value={String(payWindow)} onValueChange={(v) => setPayWindow(Number(v))}>
                    <SelectTrigger id="edit-window" className="h-11"><SelectValue /></SelectTrigger>
                    <SelectContent>{PAY_WINDOWS.map((w) => <SelectItem key={w.seconds} value={String(w.seconds)}>{w.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="edit-expiry">Expires</Label>
                <Select value={String(expiryDays)} onValueChange={(v) => setExpiryDays(Number(v))}>
                  <SelectTrigger id="edit-expiry" className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>{EXPIRY_DAYS.map((x) => <SelectItem key={x.days} value={String(x.days)}>{x.days === 0 ? "No expiry" : `In ${x.label}`}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {stable && (
                <div className="space-y-2 rounded-xl border border-border p-3">
                  <Label>{p.currency} networks{p.side === "SELL" ? " and where you receive it" : ""}</Label>
                  {networksFor(p.currency).map((n) => {
                    const on = networks.includes(n.id);
                    return (
                      <div key={n.id} className="space-y-1">
                        <label className="flex items-center gap-3 text-sm">
                          <input type="checkbox" className="h-5 w-5 accent-[hsl(var(--primary))]" checked={on} onChange={(e) => setNetworks((ns) => (e.target.checked ? [...ns, n.id] : ns.filter((x) => x !== n.id)))} />
                          {n.networkLabel}
                        </label>
                        {on && p.side === "SELL" && <Input value={addresses[n.id] ?? ""} onChange={(e) => setAddresses((a) => ({ ...a, [n.id]: e.target.value }))} placeholder={n.hint} dir="ltr" spellCheck={false} className="ml-8 h-11 w-auto font-mono text-sm" aria-label={`Your ${n.label} address`} />}
                      </div>
                    );
                  })}
                  <p className="text-xs text-muted-foreground">Changes apply to new trades only: open trades keep the address they were shown.</p>
                </div>
              )}
              {canAuto && (
                <div className={cn("flex items-start justify-between gap-3 rounded-xl border p-3", autoOn ? "border-primary bg-primary/5" : "border-border")}>
                  <div className="space-y-1">
                    <Label htmlFor="edit-auto" className="flex items-center gap-1.5"><Radar className="h-4 w-4 text-primary" />Auto-release when the payment arrives</Label>
                    <p className="text-sm text-muted-foreground">
                      {p.side === "SELL"
                        ? `Your KDA is released to the buyer automatically when the exact ${p.currency} arrives at your address. You can still release yourself.`
                        : "Sellers who take your offer get the KDA released to you automatically when your exact payment reaches their address."}
                    </p>
                    <p className="text-xs text-muted-foreground">Works for {watchedText(p.currency, auto.networks)}. Applies to new trades; open trades keep what they started with.</p>
                  </div>
                  <Switch id="edit-auto" checked={autoOn} onCheckedChange={setAutoOn} className="mt-1 shrink-0" />
                </div>
              )}
              {!free && <div className="space-y-1"><Label htmlFor="edit-notes">Note for traders</Label><Input id="edit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} className="h-11" /></div>}
              <Button className="h-12 w-full gap-2" disabled={!!busy} onClick={save}>{busy === "Save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}Save changes</Button>
            </div>
          )}

          {!closed && (
            <div className="border-t border-border pt-3">
              <Button variant="outline" className="h-11 w-full gap-2 border-destructive text-destructive hover:bg-destructive/10" disabled={!!busy} onClick={close}>
                {busy === "Close" ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                Close pool{p.side === "SELL" && p.available > 0 ? ` and get ${kdaAmount(p.available)} KDA back` : ""}
              </Button>
              {open_ > 0 && <p className="mt-1.5 text-center text-xs text-muted-foreground">{open_} open trade{open_ === 1 ? "" : "s"} continue after closing.</p>}
            </div>
          )}
        </div>
        <ConfirmDialog open={confirmClose} onOpenChange={setConfirmClose} title="Close this pool?" confirmLabel="Close the pool" destructive onConfirm={doClose}
          body={`${p.side === "SELL" ? `${kdaAmount(p.available)} unsold KDA comes back to your wallet.` : "Nothing is locked."} ${open_ ? `${open_} open trade${open_ === 1 ? "" : "s"} continue until they finish.` : "No trade is open on it."}`} />
      </SheetContent>
    </Sheet>
  );
}

type PoolTx = Awaited<ReturnType<typeof fetchTradeTxs>>[number];

/**
 * Everything that happened to a pool, newest first: its own transactions (posted, topped up, withdrawn, edited,
 * closed) with explorer links, and each take with its trade's state.
 */
function PoolHistory({ createdAt, txs, loading, trades, free, sell, onOpenTrade }: {
  createdAt?: string; txs: PoolTx[]; loading: boolean; trades: Trade[]; free: boolean; sell: boolean; onOpenTrade: (tradeId: string) => void;
}) {
  type Row = { at: string; key: string; node: JSX.Element };
  const when = (iso?: string) => (iso ? format(new Date(iso), "d MMM yyyy, HH:mm") : "");
  const rows: Row[] = [
    ...txs.map((t) => ({
      at: t.at, key: t.requestKey,
      node: (
        <a href={getTxExplorerUrl(t.requestKey)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-lg bg-muted p-3 hover:bg-muted/70">
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{t.fn === "create-offer" ? "Posted" : t.action}{t.status === "pending" ? " (confirming…)" : ""}</span>
            <span className="block text-xs text-muted-foreground">{when(t.at)} · <span className="font-mono">{t.requestKey.slice(0, 10)}…</span></span>
          </span>
          <ExternalLink className="h-4 w-4 shrink-0 text-primary" />
        </a>
      ),
    })),
    ...trades.filter((t) => t.fundedAt).map((t) => ({
      at: t.fundedAt!, key: t.tradeId,
      node: (
        <button type="button" onClick={() => onOpenTrade(t.tradeId)} className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-left hover:border-primary">
          <span className="min-w-0">
            <span className="block font-medium">{free ? "Claimed" : "Taken"}: {kdaAmount(t.amount)} KDA</span>
            <span className="block truncate text-xs text-muted-foreground">{when(t.fundedAt)} · {sell ? "buyer" : "seller"} {(sell ? t.buyer : t.seller).slice(0, 10)}…</span>
          </span>
          <EscrowStatus state={t.state as EscrowState} />
        </button>
      ),
    })),
  ];
  // the pool's creation, from the chain, when no recorded transaction says so
  if (createdAt && !txs.some((t) => t.fn === "create-offer")) {
    rows.push({ at: createdAt, key: "created", node: <div className="rounded-lg bg-muted p-3"><span className="block font-medium">Posted</span><span className="block text-xs text-muted-foreground">{when(createdAt)}</span></div> });
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));
  if (loading && rows.length === 0) return <div className="flex justify-center py-6"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">No history recorded yet.</p>;
  return (
    <div className="space-y-2">
      <ol className="space-y-2">{rows.map((r) => <li key={r.key}>{r.node}</li>)}</ol>
      <p className="text-xs text-muted-foreground">Steps made before this list existed may be missing here; they are still on the chain.</p>
    </div>
  );
}
