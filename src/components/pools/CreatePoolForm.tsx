import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useWallet } from "@/hooks/useWallet";
import { useRefreshV11 } from "@/hooks/useV11";
import { TxUnresolvedError, appChainShortfall, checkPendingTx, isInsufficientFunds, readCoinDetailsLocal, readPendingTx, type PendingTx } from "@/lib/kadena";
import { useAppChainBalance } from "@/hooks/useAppChainBalance";
import { useAutoRelease } from "@/hooks/useAutoRelease";
import { watchedText } from "@/lib/autoReleaseApi";
import { GAS_V11_CREATE, V11_CHAINS, buildCreatePoolTx, gasKda, newPoolId, poolVault } from "@/lib/v11";
import { sendV11 } from "@/lib/v11ui";
import { txFinished } from "@/lib/txProgress";
import { putPoolDetails } from "@/lib/poolsApi";
import { authProof } from "@/lib/session";
import { useMarket, vsMarket, vsMarketText } from "@/lib/market";
import { formatFiat } from "@/lib/utils";
import {
  DEFAULT_PAY_WINDOW, EXPIRY_DAYS, KADENA_TOKENS, PAY_WINDOWS, POOL_CURRENCIES, addressProblem, chainForCurrency, chainLabel, currenciesForSide, isKadenaToken, isStableCurrency, networksFor,
} from "@/lib/markets";
import { TradeEmailGate, useNeedsTradeEmail } from "../TradeEmail";
import { useMyCompletedTrades, useTermsGate } from "../Trust";
import { NEW_TRADER_MAX_KDA, NEW_TRADER_TRADES, isNewTrader, newTraderProblem } from "@/lib/trust";
import { AlertTriangle, Gift, Loader2, Lock, Plus, Radar, ShoppingCart, Store, Zap } from "lucide-react";
import { toast } from "sonner";
import { openShare, poolShareItem } from "../Share";

interface CreatePoolFormProps {
  onSuccess?: (poolId: string, requestKey: string) => void;
  role?: "buyer" | "seller";
  /** Phone layout: the page around it already sets buy or sell, so no card, no title and no side buttons. */
  compact?: boolean;
}

const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : NaN; };
/** Currencies whose chain this site uses (VITE_V11_CHAINS): a chain-2 currency is offered once chain 2 is on. */
const CURRENCY_CHOICES = POOL_CURRENCIES.filter((c) => V11_CHAINS.includes(chainForCurrency(c) ?? ""));
const fmt = (n: number) => String(Number(n.toFixed(6)));
/** How often the form asks the chain about a transaction it is still waiting for (after a reload). */
const PENDING_CHECK_MS = 10000;

/** The details save after the pool went on chain (where buyers pay), to try again when the first save failed. */
type DetailsRetry = { poolId: string; save: () => Promise<void> };

/**
 * Post a pool (escrow v11): a total with a min and max per trade. A SELL pool locks the whole total when it is
 * posted (one signature); buyers then take slices with no accept or deposit step.
 */
export function CreatePoolForm({ onSuccess, role = "seller", compact = false }: CreatePoolFormProps) {
  const { account, isConnected } = useWallet();
  const refresh = useRefreshV11();
  const [side, setSide] = useState<"BUY" | "SELL">(role === "buyer" ? "BUY" : "SELL");
  const [total, setTotal] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [minTouched, setMinTouched] = useState(false);
  const [maxTouched, setMaxTouched] = useState(false);
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState<string>("USDT");
  const [networks, setNetworks] = useState<string[]>(["USDT:TRC20"]);
  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const [payWindow, setPayWindow] = useState(DEFAULT_PAY_WINDOW);
  const [expiryDays, setExpiryDays] = useState(0);
  const [giveaway, setGiveaway] = useState(false);
  const [notes, setNotes] = useState("");
  const [autoRelease, setAutoRelease] = useState(true);
  const [busy, setBusy] = useState(false);
  // the pool is live but the server has no receiving address for it: a blocking dialog, with Retry, until it is saved
  const [detailsRetry, setDetailsRetry] = useState<DetailsRetry | null>(null);
  const [retrying, setRetrying] = useState(false);
  // a transaction this browser sent and never saw answered (page closed, or polling gave up): no new post until it settles
  const [pendingTx, setPendingTx] = useState<PendingTx | null>(() => readPendingTx());
  const free = giveaway && side === "SELL";
  const instant = !free && isKadenaToken(currency);
  const stable = !free && isStableCurrency(currency);
  const token = KADENA_TOKENS.find((t) => t.symbol === currency);
  // the currency decides the chain the pool lives on (shared/v11-chains.js); a giveaway goes on the default chain
  const chain = (free ? chainForCurrency("FREE") : chainForCurrency(currency)) ?? "1";
  const { data: chainBalance } = useAppChainBalance(account?.account, chain);
  // auto-release: offered when the platform runs its agent and one of the chosen networks is watched
  const auto = useAutoRelease();
  const canAuto = stable && auto.available && networks.some((n) => auto.networks.includes(n));
  const autoOn = canAuto && autoRelease;
  const manualNets = networks.filter((n) => !auto.networks.includes(n));

  const needsEmail = useNeedsTradeEmail();
  const [emailGateOpen, setEmailGateOpen] = useState(false);
  const myCompleted = useMyCompletedTrades();
  const formRef = useRef<HTMLFormElement>(null);
  const terms = useTermsGate(() => formRef.current?.requestSubmit());
  const { data: market } = useMarket();

  // Defaults: min = 10% of the total, max = the total, until the person edits them
  useEffect(() => {
    const t = num(total);
    if (!(t > 0)) return;
    if (!minTouched) setMin(fmt(t / 10));
    if (!maxTouched) setMax(fmt(t));
  }, [total, minTouched, maxTouched]);

  // Changing the currency: USDT/USDC start with their first network; a token has no network
  const changeCurrency = (c: string) => {
    setCurrency(c);
    setNetworks(isStableCurrency(c) ? [networksFor(c)[0].id] : []);
  };
  // A BUY offer is paid outside Kadena only (the contract refuses a token BUY after signing): switching to BUY with
  // a token chosen falls back to the first off-chain currency.
  const currencyChoices = useMemo(() => currenciesForSide(CURRENCY_CHOICES, side), [side]);
  useEffect(() => {
    if (currencyChoices.includes(currency) || !currencyChoices.length) return;
    const c = currencyChoices[0];
    setCurrency(c);
    setNetworks(isStableCurrency(c) ? [networksFor(c)[0].id] : []);
  }, [currencyChoices, currency]);

  // After a reload with a transaction still unanswered: ask the chain every few seconds until it is
  useEffect(() => {
    if (!pendingTx) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stop) return;
      const r = await checkPendingTx(pendingTx);
      if (stop) return;
      if (r === "done") setPendingTx(null);
      else timer = setTimeout(tick, PENDING_CHECK_MS);
    };
    void tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [pendingTx]);
  const toggleNetwork = (id: string, on: boolean) => setNetworks((ns) => (on ? [...ns, id] : ns.filter((n) => n !== id)));

  // The reference price: USDT and USDC track the USD market price; a token has its own
  const marketRef = useMemo(() => market?.prices?.[stable ? "USD" : currency], [market, stable, currency]);
  const pct = marketRef ? vsMarket(num(price), stable ? "USD" : currency, market) : null;

  const totalN = num(total), minN = num(min), maxN = num(max), priceN = free ? 0 : num(price);
  const problems: string[] = [];
  if (!(totalN > 0)) problems.push("Enter the total amount of KDA");
  if (!(minN > 0)) problems.push("Enter the minimum per trade");
  if (!(maxN > 0)) problems.push("Enter the maximum per trade");
  if (minN > 0 && maxN > 0 && minN > maxN) problems.push("The minimum is larger than the maximum");
  if (maxN > 0 && totalN > 0 && maxN > totalN) problems.push("The maximum per trade is larger than the total");
  if (!free && !(priceN > 0)) problems.push("Enter the price per KDA");
  if (side === "BUY" && instant) problems.push("A buy offer cannot be paid in a Kadena token; choose USDT or USDC");
  if (stable && networks.length === 0) problems.push("Choose at least one network");
  if (stable && side === "SELL") for (const n of networks) { const p = addressProblem(n, addresses[n] ?? ""); if (p) problems.push(`${n.replace(":", " ")}: ${p}`); }
  const limitProblem = maxN > 0 ? newTraderProblem(maxN, myCompleted) : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return toast.error("Please connect your wallet first");
    if (needsEmail) { setEmailGateOpen(true); return; }
    if (problems.length) return toast.error("Check the form", { description: problems[0] });
    if (limitProblem) return toast.error(`Up to ${NEW_TRADER_MAX_KDA} KDA per trade for now`, { description: limitProblem });
    if (!(await terms.check())) return;
    if (pendingTx) return toast.error("Still checking your last transaction", { description: "Wait until it is confirmed before posting another offer." });

    setBusy(true);
    const poolId = newPoolId(chain);
    try {
      const [shortfall, coin] = await Promise.all([
        appChainShortfall(account.account, side === "SELL" ? totalN : 0, chain, gasKda(GAS_V11_CREATE)),
        readCoinDetailsLocal(account.account, chain),
      ]);
      if (shortfall) { toast.error(shortfall.title, { description: shortfall.description, duration: 20000 }); return; }
      if (!coin) throw new Error(`No KDA account on chain ${chain} for ${account.account}. ${currency} offers live on chain ${chain}: move some KDA to chain ${chain} in Linx Wallet first.`);

      const vault = side === "SELL" ? await poolVault(poolId) : undefined;
      const expiresAt = expiryDays > 0 ? new Date(Date.now() + expiryDays * 86400000).toISOString() : null;
      const requestKey = await sendV11(
        free ? `Locking the ${fmt(totalN)} KDA giveaway` : side === "SELL" ? `Locking ${fmt(totalN)} KDA in your pool` : "Posting your buy offer",
        () => buildCreatePoolTx({
          poolId, creator: account.account, pubKey: account.publicKey, side, total: totalN, min: minN, max: maxN,
          // the contract wants a currency even for a giveaway (price 0, no token); "FREE" is what the lists show
          price: priceN, currency: free ? "FREE" : currency, token: instant ? token?.module ?? "" : "", payWindow, expiresAt, vault,
          agent: autoOn ? auto.agent : "",
        }),
        { hold: true },
      );

      // Then the off-chain part: the networks and where you get paid (the buyer sees the address after taking).
      // A SELL pool paid outside Kadena is not listed until this is saved, so a failure here blocks with Retry.
      if (!free) {
        const payout = side === "SELL" ? Object.fromEntries(networks.map((n) => [n, (addresses[n] ?? "").trim()])) : {};
        const body = { networks: stable ? networks : [], payout, notes: notes.trim() };
        const save = async () => {
          const signedCmd = await authProof(account.account, account.publicKey);
          await putPoolDetails(poolId, body, { wallet: account.account, publicKey: account.publicKey, signedCmd });
        };
        try {
          await save();
        } catch (err) {
          console.warn("Pool details save failed:", err);
          if (stable && side === "SELL") setDetailsRetry({ poolId, save });
          else toast.warning("Posted on chain. The server could not save the offer's details; add them from Manage.");
        }
      }
      txFinished();
      const shareItem = poolShareItem({ poolId, side, available: totalN, min: minN, max: maxN, price: free ? 0 : priceN, currency: free ? "FREE" : currency, token: instant ? token?.module ?? "" : "", state: "OPEN" });
      toast.success(free ? "Giveaway posted" : "Pool posted", {
        description: "Share it so people can find it.", duration: 12000,
        action: { label: "Share", onClick: () => openShare(shareItem) },
      });
      refresh();
      onSuccess?.(poolId, requestKey);
      setTotal(""); setMin(""); setMax(""); setMinTouched(false); setMaxTouched(false); setPrice(""); setAddresses({}); setNotes(""); setGiveaway(false);
    } catch (err) {
      txFinished();
      console.error("Create pool error:", err);
      const msg = err instanceof Error ? err.message : "Unknown error";
      // polling gave up before the chain answered: keep the form closed until it does (the pool may well be live)
      if (err instanceof TxUnresolvedError) { setPendingTx(readPendingTx()); toast.error("Still confirming on the chain", { description: msg, duration: 30000 }); return; }
      if (isInsufficientFunds(msg) && account) {
        const s = await appChainShortfall(account.account, side === "SELL" ? totalN : 0, chain).catch(() => null);
        if (s) { toast.error(s.title, { description: s.description, duration: 20000 }); return; }
      }
      toast.error("Could not post the offer", { description: msg });
    } finally {
      setBusy(false);
    }
  };

  const retryDetails = async () => {
    if (!detailsRetry) return;
    setRetrying(true);
    try { await detailsRetry.save(); setDetailsRetry(null); toast.success("Receiving address saved. Your pool is in the market."); }
    catch (err) { toast.error("Still could not save the address", { description: err instanceof Error ? err.message : "The server did not answer. Try again in a moment." }); }
    finally { setRetrying(false); }
  };

  // KDA needed on the pool's chain: the total for a SELL pool, gas only for a BUY offer
  const needOnChain = (side === "SELL" && totalN > 0 ? totalN : 0) + gasKda(GAS_V11_CREATE);
  const lowOnChain = chainBalance !== undefined && chainBalance + 1e-9 < needOnChain;
  const lockText = side === "SELL"
    ? free ? `You'll approve one transaction that locks ${total ? fmt(totalN) : "the"} KDA for the giveaway.` : `You'll approve one transaction that locks ${total ? fmt(totalN) : "the"} KDA in your pool. Buyers take slices from it; the unsold part comes back when you close the pool.`
    : "You'll approve one transaction that posts the offer. Sellers who take it lock their KDA; you pay them and they release.";

  return (
    <Card className={compact ? "border-0 bg-transparent shadow-none" : "escrow-card"}>
      {!compact && (
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Plus className="h-5 w-5 text-primary" />{role === "buyer" ? "New buy offer" : "New sell offer"}</CardTitle>
          <CardDescription>A pool with a minimum and maximum per trade. Several buyers can take slices at the same time.</CardDescription>
        </CardHeader>
      )}
      <CardContent className={compact ? "p-0" : undefined}>
        <form ref={formRef} onSubmit={handleSubmit} className="space-y-4" aria-busy={busy}>
          <div className={compact ? "hidden" : "space-y-2"}>
            <Label>Side</Label>
            <div className="flex gap-2">
              <Button type="button" variant={side === "SELL" ? "default" : "outline"} className="flex-1 gap-2" onClick={() => setSide("SELL")}><Store className="h-4 w-4" />Sell KDA</Button>
              <Button type="button" variant={side === "BUY" ? "default" : "outline"} className="flex-1 gap-2" onClick={() => { setSide("BUY"); setGiveaway(false); }}><ShoppingCart className="h-4 w-4" />Buy KDA</Button>
            </div>
          </div>

          {side === "SELL" && (
            <label className={`flex items-start gap-3 rounded-xl border p-3 text-sm ${free ? "border-primary bg-primary/5" : "border-border"}`}>
              <Checkbox checked={giveaway} onCheckedChange={(v) => setGiveaway(v === true)} className="mt-0.5" aria-label="Free giveaway" />
              <span>
                <b className="flex items-center gap-1.5"><Gift className="h-4 w-4 text-emerald-600" />Free giveaway</b>
                <span className="block text-muted-foreground">Price 0: whoever claims a slice gets it at once. Nothing to pay, nothing to release.</span>
              </span>
            </label>
          )}

          <div className="space-y-2">
            <Label htmlFor="total">{side === "SELL" ? "Total KDA to sell" : "Total KDA to buy"}</Label>
            <Input id="total" type="number" inputMode="decimal" step="any" min="0" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="1000" className="h-12 font-mono text-lg" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="min">Min per trade</Label>
              <Input id="min" type="number" inputMode="decimal" step="any" min="0" value={min} onChange={(e) => { setMin(e.target.value); setMinTouched(true); }} placeholder="100" className="h-12 font-mono" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="max">Max per trade</Label>
              <Input id="max" type="number" inputMode="decimal" step="any" min="0" value={max} onChange={(e) => { setMax(e.target.value); setMaxTouched(true); }} placeholder="1000" className="h-12 font-mono" aria-describedby={isNewTrader(myCompleted) ? "max-limit" : undefined} />
            </div>
          </div>
          {isNewTrader(myCompleted) && (
            <p id="max-limit" className={`text-xs ${limitProblem ? "text-destructive" : "text-muted-foreground"}`}>
              New traders: up to {NEW_TRADER_MAX_KDA} KDA per trade ({myCompleted} of {NEW_TRADER_TRADES} trades done).
            </p>
          )}

          {!free && (<>
            <div className="space-y-2">
              <Label htmlFor="currency">Paid in</Label>
              <Select value={currency} onValueChange={changeCurrency}>
                <SelectTrigger id="currency" className="h-12"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {currencyChoices.map((c) => (
                    <SelectItem key={c} value={c}>{isKadenaToken(c) ? `${c} · instant` : c} <span className="text-muted-foreground">· {chainLabel(chainForCurrency(c))}</span></SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {instant && (
                <p className="flex items-start gap-2 rounded-lg bg-muted p-3 text-sm">
                  <Zap className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />
                  <span>Instant: the {side === "SELL" ? "buyer pays you" : "seller is paid"} {currency} on Kadena chain {chain} and the KDA moves in the same transaction. No waiting, no release step.</span>
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="price">Price per KDA ({currency})</Label>
              <Input id="price" type="number" inputMode="decimal" step="any" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" className="h-12 font-mono text-lg" />
              {marketRef ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">
                    Market: <b className="text-foreground">{formatFiat(marketRef, stable ? "USD" : currency)} {currency}</b>
                    {pct !== null && <> · <span className={Math.abs(pct) >= 15 ? "font-medium text-amber-700 dark:text-amber-300" : ""}>yours is {vsMarketText(pct)}</span></>}
                  </span>
                  <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => setPrice(String(Number(marketRef.toPrecision(4))))}>Use market price</Button>
                </div>
              ) : null}
            </div>

            {stable && (
              <div className="space-y-3 rounded-xl border border-border p-3">
                <div>
                  <Label className="text-base">{currency} network{side === "SELL" ? " and where you receive it" : ""}</Label>
                  <p className="text-xs text-muted-foreground">
                    {side === "SELL" ? "The buyer sees the address only after taking a slice. Sending on another network loses the money, so check it twice." : "Sellers who take your offer tell you where to send it, in the trade."}
                  </p>
                </div>
                {networksFor(currency).map((n) => {
                  const on = networks.includes(n.id);
                  const problem = on && side === "SELL" && (addresses[n.id] ?? "") ? addressProblem(n.id, addresses[n.id]) : null;
                  return (
                    <div key={n.id} className="space-y-2">
                      <label className="flex items-center gap-3 text-sm">
                        <Checkbox checked={on} onCheckedChange={(v) => toggleNetwork(n.id, v === true)} aria-label={n.label} />
                        <span>{n.networkLabel}</span>
                      </label>
                      {on && side === "SELL" && (
                        <div className="space-y-1 pl-7">
                          <Input id={`address-${n.id}`} value={addresses[n.id] ?? ""} onChange={(e) => setAddresses((a) => ({ ...a, [n.id]: e.target.value }))}
                            placeholder={n.hint} dir="ltr" autoComplete="off" spellCheck={false} className="h-11 font-mono text-sm" aria-label={`Your ${n.label} address`} />
                          {problem && <p className="text-xs text-destructive">{problem}</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {canAuto && (
              <div className={`flex items-start justify-between gap-3 rounded-xl border p-3 ${autoOn ? "border-primary bg-primary/5" : "border-border"}`}>
                <div className="space-y-1">
                  <Label htmlFor="auto-release" className="flex items-center gap-1.5 text-base"><Radar className="h-4 w-4 text-primary" />Auto-release when the payment arrives</Label>
                  <p className="text-sm text-muted-foreground">
                    {side === "SELL"
                      ? `Your KDA is released to the buyer automatically when the exact ${currency} arrives at your address. You can still release yourself.`
                      : "Sellers who take your offer get the KDA released to you automatically when your exact payment reaches their address."}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Works for {watchedText(currency, auto.networks)}.
                    {manualNets.length > 0 && ` On ${manualNets.map((n) => networksFor(currency).find((x) => x.id === n)?.networkLabel ?? n).join(" and ")} the seller releases as usual.`}
                  </p>
                </div>
                <Switch id="auto-release" checked={autoRelease} onCheckedChange={setAutoRelease} className="mt-1 shrink-0" />
              </div>
            )}

            {!instant && (
              <div className="space-y-2">
                <Label htmlFor="pay-window">Payment window</Label>
                <Select value={String(payWindow)} onValueChange={(v) => setPayWindow(Number(v))}>
                  <SelectTrigger id="pay-window" className="h-12"><SelectValue /></SelectTrigger>
                  <SelectContent>{PAY_WINDOWS.map((w) => <SelectItem key={w.seconds} value={String(w.seconds)}>{w.label}</SelectItem>)}</SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">How long a buyer has to pay after taking a slice. After that and a 30-minute grace period, you can take the KDA back.</p>
              </div>
            )}
          </>)}

          <div className="space-y-2">
            <Label htmlFor="expiry">Expires</Label>
            <Select value={String(expiryDays)} onValueChange={(v) => setExpiryDays(Number(v))}>
              <SelectTrigger id="expiry" className="h-12"><SelectValue /></SelectTrigger>
              <SelectContent>{EXPIRY_DAYS.map((x) => <SelectItem key={x.days} value={String(x.days)}>{x.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>

          {!free && (
            <div className="space-y-2">
              <Label htmlFor="notes">Note for traders (optional)</Label>
              <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} placeholder="e.g. I answer within minutes" className="h-11" />
            </div>
          )}

          {account && chainBalance !== undefined && (
            <div className={`rounded-xl border p-3 text-sm ${lowOnChain ? "border-amber-500/50 bg-amber-500/10" : "border-border"}`} role={lowOnChain ? "note" : undefined}>
              <p className="tabular-nums text-muted-foreground">{chainLabel(chain)}: <b className="text-foreground">{chainBalance.toLocaleString("en-US", { maximumFractionDigits: 4 })} KDA</b></p>
              {lowOnChain && (
                <p className="mt-1">
                  {free ? "A giveaway" : `An offer in ${currency}`} lives on chain {chain}, so the KDA {side === "SELL" ? "you lock" : "for gas"} must be on chain {chain}.
                  {" "}You can move KDA to chain {chain} in Linx Wallet (a transfer to your same account on chain {chain}).
                </p>
              )}
            </div>
          )}

          <p className="flex items-start gap-2 rounded-xl border border-primary/40 bg-primary/5 p-3 text-sm">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>{lockText}</span>
          </p>

          {pendingTx && (
            <p className="flex items-start gap-2 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3 text-sm" role="status">
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
              <span>Checking your last transaction ({pendingTx.label})… Do not send it again. You can post once the chain has answered.</span>
            </p>
          )}

          <Button type="submit" className={compact ? "h-12 w-full text-base" : "w-full"} disabled={!isConnected || busy || !!pendingTx}>
            {busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Posting…</> : free ? "Post giveaway" : side === "SELL" ? `Lock ${total ? fmt(totalN) : ""} KDA and post` : "Post buy offer"}
          </Button>
          {!isConnected && <p className="text-center text-sm text-muted-foreground">Connect your wallet to post an offer</p>}

          <TradeEmailGate open={emailGateOpen} onOpenChange={setEmailGateOpen} />
          {terms.gate}
        </form>

        {/* The pool is on the chain but the server has no receiving address: nobody can take it until this is saved */}
        <Dialog open={!!detailsRetry} onOpenChange={() => { /* stays open until the address is saved or Later is pressed */ }}>
          <DialogContent className="max-w-md" onInteractOutside={(ev) => ev.preventDefault()} onEscapeKeyDown={(ev) => ev.preventDefault()}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 font-display text-xl"><AlertTriangle className="h-5 w-5 text-amber-500" />Your pool is live but has no receiving address yet</DialogTitle>
              <DialogDescription>
                The KDA is locked on the chain, but the server could not save where buyers should pay you. Until it is saved, your pool stays out of the market and nobody can take it. Add it now.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col gap-2 sm:flex-col">
              <Button type="button" className="h-12 w-full gap-2" disabled={retrying} onClick={() => void retryDetails()}>
                {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Save the receiving address again
              </Button>
              <Button type="button" variant="outline" className="h-11 w-full" disabled={retrying} onClick={() => { setDetailsRetry(null); toast.warning("Your pool is not in the market yet. Add the receiving address from Manage, then Edit."); }}>
                Later, from Manage
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
