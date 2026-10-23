import { Button } from "@/components/ui/button";
import { MarketTag } from "../MarketTag";
import { TradeCode } from "../TradeCode";
import { ProfileSummaryView } from "../ProfileSummary";
import { RatingDisplay } from "../RatingDisplay";
import { useWallet } from "@/hooks/useWallet";
import { useAutoRelease } from "@/hooks/useAutoRelease";
import { autoPoolNote } from "@/lib/autoReleaseApi";
import type { PoolListing } from "@/lib/poolsApi";
import type { RatingSummary } from "@/lib/ratingApi";
import { chainLabel, isGiveawayPool, isInstant, missingReceivingAddress, networkLabel, windowLabel } from "@/lib/markets";
import { NEW_TRADER_TRADES, isNewTrader } from "@/lib/trust";
import { formatFiat, cn } from "@/lib/utils";
import { Gift, Lock, Radar, Settings2, Zap } from "lucide-react";
import { ShareButton, poolShareItem } from "../Share";

export const kdaAmount = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
export const isExpired = (p: { expiresAt?: string }) => !!p.expiresAt && Date.parse(p.expiresAt) <= Date.now();
/** Something is left to take: open, not expired, and at least the minimum is still available. */
export const isTakeable = (p: PoolListing) => p.state === "OPEN" && !isExpired(p) && p.available >= p.min && p.available > 0;

interface PoolCardProps {
  pool: PoolListing;
  profileMap: Record<string, { username: string | null; avatar: string | null; wallet: string }>;
  ratingSummaryMap?: Record<string, RatingSummary>;
  /** Completed trades per wallet (v11 + v10), from the server */
  completedMap?: Record<string, number>;
  onTake: (pool: PoolListing) => void;
  onManage?: (pool: PoolListing) => void;
  /** Open trades of this pool, for the creator's view */
  openTrades?: number;
  className?: string;
}

/**
 * One pool in the market: what is left, the slice sizes, the price, how it is paid, who posts it, and one
 * button. The creator sees available/locked and Manage instead.
 */
export function PoolCard({ pool: p, profileMap, ratingSummaryMap, completedMap, onTake, onManage, openTrades = 0, className }: PoolCardProps) {
  const { account } = useWallet();
  const mine = p.creator === account?.account;
  const free = isGiveawayPool(p);
  const instant = isInstant(p);
  const expired = isExpired(p);
  const closed = p.state === "CLOSED";
  const noAddress = missingReceivingAddress(p);
  // a sell pool paid outside Kadena with no receiving address: not takeable until the creator adds one
  const takeable = isTakeable(p) && !noAddress;
  const trades = completedMap?.[p.creator] ?? ratingSummaryMap?.[p.creator]?.completedTrades;
  const creatorNew = !mine && isNewTrader(completedMap?.[p.creator]);
  const who = p.side === "SELL" ? "Seller" : "Buyer";
  const nets = p.networks.length ? p.networks : instant || free ? [] : [p.currency];
  const action = free ? "Claim" : p.side === "SELL" ? "Buy KDA" : "Sell KDA";
  const auto = useAutoRelease().isAuto(p) && !free;

  return (
    <div id={`pool-card-${p.poolId}`} className={cn("relative scroll-mt-28 rounded-2xl border border-border bg-card p-4", (expired || closed || p.hidden) && "opacity-75", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-display text-2xl font-bold">
          {/* kept on one line: "300 KDA left" broke into three on phones */}
          <span className="whitespace-nowrap">{kdaAmount(p.available)} KDA <span className="text-base font-normal text-muted-foreground">left</span></span>
          <TradeCode offerId={p.poolId} className="self-center" />
        </p>
        {free ? (
          <p className="shrink-0 rounded-full bg-emerald-500/15 px-3 py-1 text-sm font-bold text-emerald-700 dark:text-emerald-300"><Gift className="mr-1 inline h-4 w-4" />Free</p>
        ) : (
          <p className="shrink-0 text-right text-sm text-muted-foreground">
            <span className="font-mono text-foreground">{formatFiat(p.price, p.currency)}</span> {p.currency} / KDA
            {!instant && <MarketTag price={p.price} currency="USD" className="flex justify-end" />}
          </p>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {p.side === "SELL" ? "Selling" : "Buying"} · {kdaAmount(p.min)}–{kdaAmount(p.max)} KDA per trade{!instant && !free ? ` · pay within ${windowLabel(p.payWindow)}` : ""}
      </p>

      {mine && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
          <span className="rounded-lg bg-muted px-2.5 py-1.5">Available <b className="tabular-nums">{kdaAmount(p.available)}</b></span>
          <span className="rounded-lg bg-muted px-2.5 py-1.5"><Lock className="mr-1 inline h-3.5 w-3.5" />In trades <b className="tabular-nums">{kdaAmount(p.locked)}</b></span>
        </div>
      )}
      {closed ? (
        <p className="mt-2 rounded-lg bg-muted p-2.5 text-sm text-muted-foreground">Closed. {p.locked > 0 ? "Open trades continue until they finish." : "Nothing is locked."}</p>
      ) : expired ? (
        <p className="mt-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-2.5 text-sm">Expired: nobody can take from it any more.{mine ? " Close it to get the unsold KDA back." : ""}</p>
      ) : p.hidden && mine ? (
        <p className="mt-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-2.5 text-sm">Hidden from the market by the Marketplace. Open trades continue; close it or contact support.</p>
      ) : noAddress ? (
        <p className="mt-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-2.5 text-sm" role="note">
          {mine ? "Add your receiving address: your pool is not in the market until buyers know where to pay. Open Manage, then Edit." : "The seller has not added a receiving address yet."}
        </p>
      ) : mine && !takeable ? (
        <p className="mt-2 rounded-lg bg-muted p-2.5 text-sm text-muted-foreground">{p.available > 0 ? `Less than the minimum (${kdaAmount(p.min)} KDA) is left, so it is not in the market. Top it up or close it.` : "Sold out. Top it up or close it."}</p>
      ) : null}
      {p.notes && !mine && <p className="mt-2 text-sm italic text-muted-foreground">“{p.notes}”</p>}

      <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
        {instant && <span className="rounded-full bg-orange-500/15 px-2.5 py-1 font-medium text-orange-700 dark:text-orange-300"><Zap className="mr-1 inline h-3 w-3" />Instant</span>}
        {auto && (
          <span className="rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary" title={mine ? "Your trades on this offer are released automatically when the exact payment arrives." : autoPoolNote(p.side, p.currency)}>
            <Radar className="mr-1 inline h-3 w-3" aria-hidden="true" />Auto-release
          </span>
        )}
        {nets.map((n) => <span key={n} className="rounded-full bg-muted px-2.5 py-1">{networkLabel(n)}</span>)}
        {instant && <span className="rounded-full bg-muted px-2.5 py-1">{p.currency} on Kadena</span>}
        <span className="rounded-full px-2 py-1 text-muted-foreground" title={`This offer and its trades are on Kadena chain ${p.chain}`}>{chainLabel(p.chain)}</span>
        {!mine && (
          <span className="rounded-full bg-muted px-2.5 py-1">
            {who}: {trades ? `${trades} trade${trades === 1 ? "" : "s"}` : profileMap[p.creator]?.username || `${p.creator.slice(0, 6)}…${p.creator.slice(-4)}`}
          </span>
        )}
        {creatorNew && <span className="rounded-full bg-amber-500/15 px-2.5 py-1 font-medium text-amber-700 dark:text-amber-300" title={`Fewer than ${NEW_TRADER_TRADES} completed trades`}>New trader</span>}
        {mine && openTrades > 0 && <span className="rounded-full bg-muted px-2.5 py-1">{openTrades} open trade{openTrades === 1 ? "" : "s"}</span>}
      </div>

      {!mine && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <ProfileSummaryView wallet={p.creator} summary={profileMap[p.creator]} size="sm" />
          <RatingDisplay summary={ratingSummaryMap?.[p.creator]} variant="compact" className="text-xs" />
        </div>
      )}

      <div className="mt-3 flex gap-2">
        {mine ? (
          <Button className="h-12 flex-1 gap-2 text-base" variant="outline" onClick={() => onManage?.(p)}>
            <Settings2 className="h-4 w-4" />Manage
          </Button>
        ) : (
          <Button className="h-12 flex-1 text-base" disabled={!takeable} onClick={() => onTake(p)}>
            {takeable ? action : closed ? "Closed" : expired ? "Expired" : noAddress ? "No address yet" : "Nothing left"}
          </Button>
        )}
        {!closed && !expired && <ShareButton item={poolShareItem(p)} iconOnly />}
      </div>
    </div>
  );
}
