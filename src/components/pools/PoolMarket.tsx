import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useWallet } from "@/hooks/useWallet";
import { usePools, useTrades } from "@/hooks/useV11";
import { fetchProfilesBulk, type ProfileSummary } from "@/lib/profileApi";
import { fetchRatingSummariesBulk, type RatingSummary } from "@/lib/ratingApi";
import { initializeOnlineStatus } from "@/hooks/useOnlineStatus";
import { useCompletedCounts } from "../Trust";
import { KADENA_TOKENS, PAYMENT_NETWORKS, isGiveawayPool, isInstant, missingReceivingAddress, poolFitsTable } from "@/lib/markets";
import { getPoolsOf, type PoolListing } from "@/lib/poolsApi";
import { PoolCard, isTakeable } from "./PoolCard";
import { TakeSheet } from "./TakeSheet";
import { ManagePool } from "./ManagePool";
import { Loader2, RefreshCw, SlidersHorizontal } from "lucide-react";
import { OpenLinkButton } from "../Share";
import { isPoolRef, refFromLink } from "@/lib/share";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface PoolFilters { pay: string; amount: string; instantOnly: boolean }
export const emptyPoolFilters = (): PoolFilters => ({ pay: "", amount: "", instantOnly: false });
export const poolFilterCount = (f: PoolFilters) => (f.pay ? 1 : 0) + (f.amount ? 1 : 0) + (f.instantOnly ? 1 : 0);

/** Profiles, ratings and completed counts for a set of wallets (what the cards show). */
function useTraderInfo(wallets: string[]) {
  const ws = useMemo(() => [...new Set(wallets.filter(Boolean))].sort(), [wallets]);
  const key = ws.join(",");
  const { data: profileMap = {} } = useQuery<Record<string, ProfileSummary>>({ queryKey: ["profiles-bulk", key], queryFn: () => fetchProfilesBulk(ws), enabled: ws.length > 0 });
  const { data: ratingSummaryMap = {} } = useQuery<Record<string, RatingSummary>>({ queryKey: ["ratings-summary-bulk", key], queryFn: () => fetchRatingSummariesBulk(ws), enabled: ws.length > 0 });
  const { data: completedMap } = useCompletedCounts(ws);
  useEffect(() => { if (Object.keys(profileMap).length) initializeOnlineStatus(profileMap); }, [profileMap]);
  return { profileMap, ratingSummaryMap, completedMap };
}

/** Filter bar: pay with (currency/network), amount I want, instant only. */
export function PoolFilterBar({ filters, onChange, side }: { filters: PoolFilters; onChange: (f: PoolFilters) => void; side: "buyer" | "seller" }) {
  return (
    <div className="grid gap-3 rounded-xl border border-border bg-card p-3 sm:grid-cols-3">
      <div className="space-y-1">
        <Label htmlFor="f-pay" className="text-xs text-muted-foreground">{side === "buyer" ? "Pay with" : "Get paid in"}</Label>
        <Select value={filters.pay || "ANY"} onValueChange={(v) => onChange({ ...filters, pay: v === "ANY" ? "" : v })}>
          <SelectTrigger id="f-pay" className="h-10"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ANY">Anything</SelectItem>
            {PAYMENT_NETWORKS.map((n) => <SelectItem key={n.id} value={n.id}>{n.label}</SelectItem>)}
            {KADENA_TOKENS.map((t) => <SelectItem key={t.symbol} value={t.symbol}>{t.symbol} · instant</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="f-amount" className="text-xs text-muted-foreground">Amount I want (KDA)</Label>
        <Input id="f-amount" type="number" inputMode="decimal" min="0" step="any" value={filters.amount} onChange={(e) => onChange({ ...filters, amount: e.target.value })} placeholder="e.g. 200" className="h-10" />
      </div>
      <label className="flex items-center gap-3 self-end rounded-lg border border-border px-3 py-2 text-sm">
        <input type="checkbox" className="h-5 w-5 accent-[hsl(var(--primary))]" checked={filters.instantOnly} onChange={(e) => onChange({ ...filters, instantOnly: e.target.checked })} />
        Instant only
      </label>
    </div>
  );
}

/**
 * Pools that match the filters, for the side I am on. Mine are shown even when nothing is left. A pool whose
 * chain, currency and token module do not match the table (e.g. "kb-USDC" naming another module) is not listed,
 * and neither is a USDT/USDC sell pool with no receiving address yet (nobody could pay it).
 */
export function filterPools(pools: PoolListing[], side: "buyer" | "seller", f: PoolFilters, me?: string): PoolListing[] {
  const want = side === "buyer" ? "SELL" : "BUY";
  const amount = parseFloat(f.amount);
  return pools
    .filter((p) => p.side === want)
    .filter((p) => p.creator === me || (isTakeable(p) && !p.hidden && poolFitsTable(p) && !missingReceivingAddress(p)))
    .filter((p) => !f.instantOnly || isInstant(p))
    .filter((p) => !f.pay || p.currency === f.pay || p.networks.includes(f.pay))
    .filter((p) => !(amount > 0) || p.creator === me || (amount >= p.min && amount <= p.max && amount <= p.available))
    .sort((a, b) => {
      if ((a.creator === me) !== (b.creator === me)) return a.creator === me ? -1 : 1;
      if (isGiveawayPool(a) !== isGiveawayPool(b)) return isGiveawayPool(a) ? -1 : 1;
      return want === "SELL" ? a.price - b.price : b.price - a.price; // buying: cheapest first; selling: best bid first
    });
}

interface PoolMarketProps {
  side: "buyer" | "seller";
  refreshTrigger?: number;
  /** Hide the filter row (the page shows its own) */
  filters?: PoolFilters;
}

/** The market: pool cards for the side I am on, the take sheet, and Manage for my own pools. */
export function PoolMarket({ side, refreshTrigger = 0, filters: outer }: PoolMarketProps) {
  const { account } = useWallet();
  const me = account?.account;
  const navigate = useNavigate();
  const { pools, isLoading, refetch } = usePools();
  const { data: trades = [] } = useTrades();
  const [inner, setInner] = useState<PoolFilters>(emptyPoolFilters);
  const [showFilters, setShowFilters] = useState(false);
  const filters = outer ?? inner;
  const [taking, setTaking] = useState<PoolListing | null>(null);
  const [managing, setManaging] = useState<PoolListing | null>(null);

  useEffect(() => { if (refreshTrigger) void refetch(); }, [refreshTrigger, refetch]);

  // A shared link (/s/<pool> → ?offer=<pool>): open that pool's take sheet (or Manage, for its creator) once the
  // pools are loaded, and take the parameter out of the address.
  const [params, setParams] = useSearchParams();
  const linked = refFromLink(params.get("offer") ?? params.get("pool") ?? "");
  const linkDone = useRef<string | null>(null);
  useEffect(() => {
    if (!linked || !isPoolRef(linked) || linkDone.current === linked || isLoading) return;
    linkDone.current = linked;
    const p = pools.find((x) => x.poolId === linked);
    const next = new URLSearchParams(params); next.delete("offer"); next.delete("pool");
    setParams(next, { replace: true });
    if (!p) { toast.info("That offer is closed", { description: "Here's what's open now." }); return; }
    if (p.creator === me) setManaging(p);
    else if (isTakeable(p)) setTaking(p);
    else toast.info("Nothing is left in that offer");
    setTimeout(() => document.getElementById(`pool-card-${p.poolId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 200);
  }, [linked, isLoading, pools, me, params, setParams]);

  const shown = useMemo(() => filterPools(pools, side, filters, me), [pools, side, filters, me]);
  const info = useTraderInfo(shown.map((p) => p.creator));
  const openTradesOf = (p: PoolListing) => trades.filter((t) => t.poolId === p.poolId && ["FUNDED", "PAID", "DISPUTED"].includes(t.state)).length;
  const managingLive = managing ? pools.find((p) => p.poolId === managing.poolId) ?? managing : null;
  const openTrade = (tradeId: string) => { setManaging(null); navigate(`/?offer=${encodeURIComponent(tradeId)}`); };
  const n = poolFilterCount(filters);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        {!outer ? (
          <Button variant="outline" className="h-10 gap-2 rounded-full" aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
            <SlidersHorizontal className="h-4 w-4" />Filters{n ? ` (${n})` : ""}
          </Button>
        ) : <span />}
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {isLoading && pools.length === 0 ? "Loading…" : `${shown.length} ${shown.length === 1 ? "offer" : "offers"}`}
        </p>
        <OpenLinkButton className="px-2" />
        <Button variant="ghost" size="sm" className="h-10 gap-2" onClick={() => void refetch()} disabled={isLoading}>
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}Refresh
        </Button>
      </div>
      {!outer && showFilters && <PoolFilterBar filters={inner} onChange={setInner} side={side} />}

      {isLoading && pools.length === 0 ? (
        <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
      ) : shown.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">
          {n ? "No offers match your filters." : side === "buyer" ? "Nobody is selling KDA right now. Post a buy offer and sellers will take it." : "Nobody is buying KDA right now. Post a sell offer and buyers will take it."}
        </p>
      ) : (
        <div className={cn("grid grid-cols-1 gap-3", "md:grid-cols-2 lg:grid-cols-3")}>
          {shown.map((p) => (
            <PoolCard key={p.poolId} pool={p} profileMap={info.profileMap} ratingSummaryMap={info.ratingSummaryMap} completedMap={info.completedMap}
              onTake={setTaking} onManage={setManaging} openTrades={openTradesOf(p)} />
          ))}
        </div>
      )}

      <TakeSheet pool={taking} open={!!taking} onOpenChange={(o) => { if (!o) setTaking(null); }} profileMap={info.profileMap} onTaken={(tradeId) => openTrade(tradeId)} />
      <ManagePool pool={managingLive} open={!!managing} onOpenChange={(o) => { if (!o) setManaging(null); }}
        trades={managing ? trades.filter((t) => t.poolId === managing.poolId).sort((a, b) => (b.fundedAt ?? "").localeCompare(a.fundedAt ?? "")) : []} onOpenTrade={openTrade} />
    </div>
  );
}

/**
 * The connected wallet's pools, with Manage: open ones, then the closed ones (from the server, since the chain lists
 * open pools only). For the My trades screen.
 */
export function MyPools({ onOpenTrade }: { onOpenTrade?: (tradeId: string) => void }) {
  const { account } = useWallet();
  const me = account?.account;
  const navigate = useNavigate();
  const { pools } = usePools();
  const { data: trades = [] } = useTrades();
  const { data: ofMe = [] } = useQuery({ queryKey: ["pools-of", me], queryFn: () => getPoolsOf(me!), enabled: !!me, staleTime: 15 * 1000 });
  const [managing, setManaging] = useState<PoolListing | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const mine = useMemo(() => {
    // the live chain read wins for open pools; the server list adds the closed ones
    const byId = new Map<string, PoolListing>(ofMe.map((p) => [p.poolId, p]));
    for (const p of pools) if (p.creator === me) byId.set(p.poolId, p);
    return [...byId.values()].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  }, [pools, ofMe, me]);
  const openPools = mine.filter((p) => p.state === "OPEN");
  const closedPools = mine.filter((p) => p.state !== "OPEN");
  const info = useTraderInfo([]);
  if (!me || mine.length === 0) return null;
  const managingLive = managing ? mine.find((p) => p.poolId === managing.poolId) ?? managing : null;
  const open = (id: string) => { setManaging(null); (onOpenTrade ?? ((t: string) => navigate(`/?offer=${encodeURIComponent(t)}`)))(id); };
  const card = (p: PoolListing) => (
    <PoolCard key={p.poolId} pool={p} profileMap={info.profileMap} onTake={() => {}} onManage={setManaging}
      openTrades={trades.filter((t) => t.poolId === p.poolId && ["FUNDED", "PAID", "DISPUTED"].includes(t.state)).length} />
  );
  return (
    <section className="space-y-3">
      {openPools.length > 0 && (
        <>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Your pools</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">{openPools.map(card)}</div>
        </>
      )}
      {closedPools.length > 0 && (
        <div className="space-y-3">
          <button type="button" onClick={() => setShowClosed((v) => !v)} aria-expanded={showClosed}
            className="flex w-full items-center justify-between rounded-xl border border-border px-3 py-2.5 text-sm font-semibold text-muted-foreground hover:border-primary">
            <span>Closed pools ({closedPools.length})</span>
            <span aria-hidden="true">{showClosed ? "−" : "+"}</span>
          </button>
          {showClosed && <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">{closedPools.map(card)}</div>}
        </div>
      )}
      <ManagePool pool={managingLive} open={!!managing} onOpenChange={(o) => { if (!o) setManaging(null); }}
        trades={managing ? trades.filter((t) => t.poolId === managing.poolId).sort((a, b) => (b.fundedAt ?? "").localeCompare(a.fundedAt ?? "")) : []} onOpenTrade={open} />
    </section>
  );
}
