import { useState, useEffect, useMemo, useRef } from "react";
import { MarketTag } from "./MarketTag";
import { TradeCode } from "./TradeCode";
import { ShareButton, tradeShareItem } from "./Share";
import type { IUnsignedCommand } from "@kadena/client";
import { createPortal } from "react-dom";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EscrowStatus } from "./EscrowStatus";
import { ProfileSummaryView } from "./ProfileSummary";
import { OfferCard } from "./OfferCard";
import { PayoutCard } from "./PayoutCard";
import { ConfirmDialog, MarkPaidDialog, ProofCard, ReleaseDialog } from "./TradeSafety";
import { TradeEmailGate, useNeedsTradeEmail } from "./TradeEmail";
import { useCompletedCounts, useTermsGate } from "./Trust";
import { NEW_TRADER_MAX_KDA, newTraderProblem } from "@/lib/trust";
import { repeatOffer } from "@/lib/repeatOffer";
import { getHiddenOffers, relistOffer } from "@/lib/moderationApi";
import { setTxLabel, txFinished } from "@/lib/txProgress";
import { OFFER_LISTING_DAYS, UNFUNDED_TRADE_DAYS } from "@/lib/markets";
import { getSocket } from "@/hooks/useOnlineStatus";
import { currencyPrefix, isGiveaway } from "@/lib/markets";
import { getPayout } from "@/lib/payoutApi";
import { TradeTxList } from "./TradeTxList";
import { DisputeView } from "./DisputeView";
import { OfferChat } from "./OfferChat";
import { getDispute, openDispute, putFundTxRequestKey } from "@/lib/disputeApi";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useWallet } from "@/hooks/useWallet";
import { useAppChainBalance } from "@/hooks/useAppChainBalance";
import { fetchProfilesBulk, type ProfileSummary } from "@/lib/profileApi";
import { fetchRatingSummariesBulk, registerCompletion, checkCanRate, fetchTradeRatings, type RatingSummary } from "@/lib/ratingApi";
import { initializeOnlineStatus, useOnlineStatusMap } from "@/hooks/useOnlineStatus";
import { RatingDisplay } from "./RatingDisplay";
import { RatingSubmitDialog } from "./RatingSubmitDialog";
import {
  listAllEscrows,
  TX_GAS_KDA,
  CHAIN_ID,
  TxUnresolvedError,
  appChainShortfall,
  isInsufficientFunds,
  isPayWindowPassed,
  PAY_WINDOW_PASSED_MESSAGE,
  buildAcceptOfferTx,
  buildDepositTx,
  buildMarkPaidTx,
  buildReleaseTx,
  buildRefundTx,
  buildDeleteOfferTx,
  buildCancelAcceptedOfferTx,
  buildTimeoutAcceptedCloseTx,
  buildTimeoutFundedRefundTx,
  buildTimeoutPaidDisputeTx,
  getEscrowVaultAccount,
  getTxExplorerUrl,
  getAccountExplorerUrl,
  getReputation,
  signTransaction,
  submitTransaction,
  pollTransaction,
  T1_SECONDS,
  T2_SECONDS,
  T3_SECONDS,
  readEscrow,
  type Escrow,
} from "@/lib/kadena";
import { getOfferDetails } from "@/lib/offerDetailsApi";
import { formatFiat } from "@/lib/utils";
import {
  GAS_V11,
  canonicalRef,
  gasKda,
  readTrade,
  buildMarkPaidTx as buildV11MarkPaidTx, buildReleaseTx as buildV11ReleaseTx, buildCancelTx as buildV11CancelTx,
  buildTimeoutRefundTx as buildV11TimeoutRefundTx, buildOpenDisputeTx as buildV11OpenDisputeTx,
  buildFreeStepTx, isFreeTrade, readFreeTakes, takeBackLeft, type FreeStep,
} from "@/lib/v11";
import { PAY_MARGIN_S, exactPay, isV11, toV11Escrow, payText, loadV11Escrows, type V11Escrow } from "@/lib/v11ui";
import { PoolPayoutCard } from "./pools/PoolPayoutCard";
import { AutoReleaseCard } from "./pools/AutoReleaseCard";
import { useTradeAuto } from "@/hooks/useAutoRelease";
import { getIncoming, isAutoActive } from "@/lib/autoReleaseApi";
import { chainLabel, isGiveawayPool, isInstant, networkLabel, windowLabel } from "@/lib/markets";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TradeTimer, getRemainingSeconds, isStepExpired, nextStep } from "./TradeTimer";
import { TradeSteps, YourTurnCard, kdaAmount, tradeTitle, turnInfo } from "./MobileTrade";
import { useIsMobile } from "@/hooks/use-mobile";
import type { OfferFilters } from "./OfferFilters";
import { 
  List,
  Loader2, 
  UserPlus, 
  Lock, 
  DollarSign, 
  Unlock,
  RotateCcw,
  ExternalLink,
  RefreshCw,
  AlertTriangle,
  FileText,
  MessageCircle,
  Star,
  Info,
  XCircle,
  ArrowLeft,
} from "lucide-react";
import { authProof } from "@/lib/session";
import { toast } from "sonner";

interface TransactionResult {
  action: string;
  requestKey: string;
  timestamp: Date;
  /** Trade the transaction belongs to (the list below shows only the open trade's) */
  offerId?: string;
}

interface EscrowActionsProps {
  refreshTrigger?: number;
  filters?: OfferFilters;
  role?: "buyer" | "seller";
  viewMode?: "all" | "my" | "myPast" | "active" | "new" | "mine"; // "new" = CREATED only; "myPast" = my offers excluding CREATED; "mine" = everything I created or trade in (phone "My trades")
}

export function EscrowActions({ refreshTrigger = 0, filters, role = "seller", viewMode = "all" }: EscrowActionsProps) {
  const { account, isConnected } = useWallet();
  const isMobile = useIsMobile();
  const { data: appChainBalance, refetch: refetchAppChainBalance } = useAppChainBalance(isConnected ? account?.account : undefined);
  const queryClient = useQueryClient();
  const [allEscrows, setAllEscrows] = useState<Escrow[]>([]);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [deletingOfferId, setDeletingOfferId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<TransactionResult[]>([]);
  const [disputeTab, setDisputeTab] = useState("details");
  const [showRatingDialog, setShowRatingDialog] = useState(false);
  const [registeringCompletion, setRegisteringCompletion] = useState(false);

const ACTIVE_STATES = ["ACCEPTED", "FUNDED", "PAID", "DISPUTED"] as const;
/**
 * What the buyer pays: the contract's pay-amount for a v11 trade (exactly as stored, up to 6 decimals, so the
 * amount confirmed in Mark paid and Release is the one to send), amount × price for a v10 one.
 */
const tradeTotal = (e: Escrow) => isGiveaway(e) ? "Free"
  : isV11(e) ? `${isInstant(e.trade) ? formatFiat(e.trade.payAmount, e.trade.currency) : exactPay(e.trade.payAmount)} ${e.trade.currency}`
  : `${currencyPrefix(e.fiatCurrency)}${formatFiat(e.amount * e.price, e.fiatCurrency)}`;
const PAST_TERMINAL_STATES = ["COMPLETED", "REFUNDED", "CLOSED", "CANCELLED", "SPLIT"] as const;
/** Accepted, never funded, for days: nothing is locked and it cannot go ahead, so it is filed under Finished. */
const unfundedExpired = (e: Escrow) => e.state === "ACCEPTED" && !!e.acceptedAt && Date.now() - new Date(e.acceptedAt).getTime() > UNFUNDED_TRADE_DAYS * 86400000;
/** Open offers whose creator has not been active for this many days are faded and listed last. */
const INACTIVE_DAYS = 3;
/** Title of the "keep this page open" countdown for each step. */
function txLabel(action: string, e: Escrow | null | undefined): string {
  const kda = e ? `${e.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })} KDA` : "the KDA";
  switch (action) {
    case "Accept Offer": return "Accepting the offer";
    case "Deposit": return `Locking ${kda} in escrow`;
    case "Mark Paid": return "Marking the trade as paid";
    case "Release": return `Releasing ${kda}`;
    case "Refund": case "Timeout: Refund (T2)": return `Returning ${kda} to the seller`;
    case "Delete Offer": return "Deleting the offer";
    case "Cancel Offer": return "Cancelling the offer";
    case "Close (T1 Expired)": return "Closing the trade";
    case "Timeout: Dispute (T3)": case "Open dispute": return "Moving the trade to dispute";
    case "Cancel": return `Cancelling: ${kda} goes back to the pool`;
    case "Take KDA back": return `Taking ${kda} back`;
    default: return "Confirming your transaction";
  }
}
const CRITICAL_ACTION_LOADING = ["Accept Offer", "Deposit", "Mark Paid", "Release", "Delete Offer"] as const;
const TX_CONFIRM_MESSAGE = "Transaction in progress… Confirming on the Kadena network. This may take up to 2 minutes.";

  // Filter escrows based on filters and role
  const escrows = useMemo(() => {
    let filtered = [...allEscrows];

    // Only show offers that are not DELETED (on-chain list-escrow-ids already excludes them; this is a safeguard)
    filtered = filtered.filter((e) => e.state !== "DELETED");

    // View mode and role-based filtering
    if (viewMode === "active") {
      // My active trades: I'm seller or buyer, and state is in progress (not CREATED/terminal)
      filtered = filtered.filter(
        (e) =>
          account?.account &&
          (e.seller === account.account || e.buyer === account.account) &&
          ACTIVE_STATES.includes(e.state as (typeof ACTIVE_STATES)[number])
      );
    } else if (viewMode === "new") {
      // New offers only (CREATED), by role
      filtered = filtered.filter((e) => e.state === "CREATED");
      if (role === "buyer") {
        filtered = filtered.filter((e) => e.side === "SELL");
      } else {
        filtered = filtered.filter((e) => e.side === "BUY");
      }
    } else if (viewMode === "mine") {
      // Phone "My trades": in progress, my open offers, and finished trades
      filtered = filtered.filter(
        (e) => account?.account && (e.creator === account.account || e.seller === account.account || e.buyer === account.account),
      );
    } else if (viewMode === "my") {
      // Show only offers created by the current user (creator), not just where they are the seller
      filtered = filtered.filter((e) => e.creator === account?.account);
    } else if (viewMode === "myPast") {
      // All my past offers: I'm creator, seller, or buyer, and state is terminal (Completed, Refunded, Closed)
      filtered = filtered.filter(
        (e) =>
          account?.account &&
          (e.creator === account.account || e.seller === account.account || e.buyer === account.account) &&
          PAST_TERMINAL_STATES.includes(e.state as (typeof PAST_TERMINAL_STATES)[number])
      );
    } else {
      // Show all offers based on role
      if (role === "buyer") {
        // Buyers see all sell offers (any state)
        filtered = filtered.filter((e) => e.side === "SELL");
      } else {
        // Sellers see all buy offers (any state)
        filtered = filtered.filter((e) => e.side === "BUY");
      }
    }

    // Apply filters
    if (filters) {
      if (filters.state !== "ALL") {
        filtered = filtered.filter((e) => e.state === filters.state);
      }

      if (filters.side !== "ALL") {
        filtered = filtered.filter((e) => e.side === filters.side);
      }

      if (filters.minAmount) {
        const min = parseFloat(filters.minAmount);
        if (!isNaN(min)) {
          filtered = filtered.filter((e) => e.amount >= min);
        }
      }

      if (filters.maxAmount) {
        const max = parseFloat(filters.maxAmount);
        if (!isNaN(max)) {
          filtered = filtered.filter((e) => e.amount <= max);
        }
      }

      if (filters.minPrice) {
        const min = parseFloat(filters.minPrice);
        if (!isNaN(min)) {
          filtered = filtered.filter((e) => e.price >= min);
        }
      }

      if (filters.maxPrice) {
        const max = parseFloat(filters.maxPrice);
        if (!isNaN(max)) {
          filtered = filtered.filter((e) => e.price <= max);
        }
      }

      if (filters.paymentMethod) {
        const methodLower = filters.paymentMethod.toLowerCase();
        filtered = filtered.filter((e) => {
          try {
            const methods = JSON.parse(e.paymentMethod || "[]");
            return methods.some((m: string) => m.toLowerCase().includes(methodLower));
          } catch {
            return e.paymentMethod.toLowerCase().includes(methodLower);
          }
        });
      }

      if (filters.seller) {
        const sellerLower = filters.seller.toLowerCase();
        filtered = filtered.filter((e) => e.seller.toLowerCase().includes(sellerLower));
      }

      if (filters.buyer) {
        const buyerLower = filters.buyer.toLowerCase();
        filtered = filtered.filter(
          (e) => e.buyer && e.buyer.toLowerCase().includes(buyerLower)
        );
      }
    }

    // Sort: active view by state; "new" view by price (buy: lowest first, sell: highest first); else by price
    filtered.sort((a, b) => {
      if (viewMode === "active" || viewMode === "mine") {
        const order = { PAID: 0, FUNDED: 1, DISPUTED: 2, ACCEPTED: 3, CREATED: 4 };
        return (order[a.state as keyof typeof order] ?? 5) - (order[b.state as keyof typeof order] ?? 5);
      }
      if (viewMode === "new" || role === "buyer") {
        return a.price - b.price; // Buy: lowest price first
      } else {
        return b.price - a.price; // Sell: highest price first
      }
    });

    return filtered;
  }, [allEscrows, filters, role, account?.account, viewMode]);

  // Off-chain offer details (price, limits, payment); merge with chain data for display
  const offerIds = useMemo(() => [...new Set(allEscrows.filter((e) => !isV11(e)).map((e) => e.offerId))], [allEscrows]);
  const { data: offerDetailsMap = {} } = useQuery({
    queryKey: ["offer-details", offerIds.sort().join(",")],
    queryFn: async () => {
      const map: Record<string, Awaited<ReturnType<typeof getOfferDetails>>> = {};
      await Promise.all(
        offerIds.map(async (id) => {
          const d = await getOfferDetails(id);
          if (d) map[id] = d;
        })
      );
      return map;
    },
    enabled: offerIds.length > 0,
  });

  const escrowsWithDetails = useMemo(
    () =>
      escrows.map((e) => {
        const details = offerDetailsMap[e.offerId];
        return details && !isV11(e)
          ? { ...e, price: details.price, paymentMethod: details.paymentMethod, fiatCurrency: details.fiatCurrency,
              listedUntil: details.listedSince && details.expiryDays ? new Date(new Date(details.listedSince).getTime() + details.expiryDays * 86400000).toISOString() : undefined }
          : e;
      }),
    [escrows, offerDetailsMap]
  );

  const selectedEscrow = escrowsWithDetails.find((e) => e.offerId === selectedOfferId) ?? null;

  const allWallets = useMemo(() => {
    const set = new Set<string>();
    escrowsWithDetails.forEach((e) => {
      set.add(e.seller);
      if (e.buyer) set.add(e.buyer);
      set.add(e.arbiter);
    });
    return Array.from(set);
  }, [escrowsWithDetails]);

  const { data: profileMap = {} } = useQuery<Record<string, ProfileSummary>>({
    queryKey: ["profiles-bulk", allWallets.join(",")],
    queryFn: () => fetchProfilesBulk(allWallets),
    enabled: allWallets.length > 0,
  });

  useEffect(() => {
    if (Object.keys(profileMap).length > 0) {
      initializeOnlineStatus(profileMap);
    }
  }, [profileMap]);

  // Check if there's an open dispute for the selected escrow
  const { data: existingDispute } = useQuery({
    queryKey: ["dispute-check", selectedEscrow?.offerId],
    queryFn: () => selectedEscrow ? getDispute(selectedEscrow.offerId) : null,
    enabled: !!selectedEscrow,
  });

  // Rating summary for all wallets (offer cards + detail)
  const { data: ratingSummaryMap = {} } = useQuery<Record<string, RatingSummary>>({
    queryKey: ["ratings-summary-bulk", allWallets.join(",")],
    queryFn: () => fetchRatingSummariesBulk(allWallets),
    enabled: allWallets.length > 0,
  });

  const onlineStatusMap = useOnlineStatusMap(allWallets);

  // Open offers the arbiter hid from the market (forgotten ones): not listed for others; the creator sees a note
  const { data: hiddenList = [] } = useQuery({ queryKey: ["hidden-offers"], queryFn: getHiddenOffers, staleTime: 30 * 1000 });
  const hiddenIds = useMemo(() => new Set(hiddenList.map((h) => h.offerId)), [hiddenList]);
  const hiddenReasons = useMemo(() => new Map(hiddenList.map((h) => [h.offerId, h.reason as string])), [hiddenList]);
  const handleRelist = async (e: Escrow) => {
    if (!account) return;
    try {
      await relistOffer(e.offerId, account);
      queryClient.invalidateQueries({ queryKey: ["hidden-offers"] });
      queryClient.invalidateQueries({ queryKey: ["offer-details"] });
      toast.success(hiddenReasons.has(e.offerId) ? "Back in the market" : "Kept listed", { description: `Listed for another ${OFFER_LISTING_DAYS} days.` });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not list it again");
    }
  };

  // Completed trades on the chain: "New trader" on cards, and the new-trader limit when accepting
  const { data: completedMap } = useCompletedCounts(
    account ? [...allWallets, ...escrowsWithDetails.map((e) => e.creator), account.account] : [...allWallets, ...escrowsWithDetails.map((e) => e.creator)],
  );
  const myCompleted = account ? completedMap?.[account.account] : undefined;

  // Apply reputation (min stars) and online-now filters for display
  const displayedEscrows = useMemo(() => {
    let list = viewMode === "mine" ? escrowsWithDetails : escrowsWithDetails.filter((e) => !(hiddenIds.has(e.offerId) && e.state === "CREATED" && e.creator !== account?.account));
    if (!filters) return list;
    const minStars = filters.minStars ? parseInt(filters.minStars, 10) : 0;
    if (minStars >= 1 && minStars <= 5) {
      list = list.filter((e) => {
        const counterparty = role === "buyer" ? e.seller : e.buyer;
        if (!counterparty) return false;
        const summary = ratingSummaryMap[counterparty];
        const avg = summary?.averageRating ?? 0;
        return avg >= minStars;
      });
    }
    if (filters.onlineNow) {
      list = list.filter((e) => {
        const counterparty = role === "buyer" ? e.seller : e.buyer;
        if (!counterparty) return false;
        return onlineStatusMap.get(counterparty) === true;
      });
    }
    return list;
  }, [escrowsWithDetails, filters, role, ratingSummaryMap, onlineStatusMap, viewMode, hiddenIds, account?.account]);

  // Bulk dispute check for offer cards: which offerIds have an open/active dispute (must be after displayedEscrows)
  const disputeQueries = useQueries({
    queries: displayedEscrows.map((e) => ({
      queryKey: ["dispute-check", e.offerId],
      queryFn: () => getDispute(e.offerId),
      enabled: true,
    })),
  });
  const openDisputeOfferIds = useMemo(() => {
    const set = new Set<string>();
    disputeQueries.forEach((q, i) => {
      const d = q.data;
      if (d && (d.status === "OPEN" || d.status === "UNDER_REVIEW"))
        set.add(displayedEscrows[i]?.offerId ?? "");
    });
    return set;
  }, [disputeQueries, displayedEscrows]);

  // Link to an offer or trade (?offer=ID) from an alert email or a notification: select it once it is in
  // this list and scroll to it. Reacts every time the link changes, not only on first load.
  const [searchParams, setSearchParams] = useSearchParams();
  // "?offer=2:trade-…" names a trade on chain 2; "1:x" and "x" are the same chain-1 trade
  const linkedParam = searchParams.get("offer");
  const linkedOffer = linkedParam ? canonicalRef(linkedParam) : null;
  const handledLink = useRef<string | null>(null);
  const reloadedFor = useRef<string | null>(null);
  const linkKey = useLocation().key;
  useEffect(() => {
    if (!linkedOffer || handledLink.current === linkKey) return;
    if (viewMode !== "new" && viewMode !== "active" && viewMode !== "mine") return;
    // Load the list fresh first: the link usually comes from a notification about something that just changed
    if (reloadedFor.current !== linkKey) {
      if (!isLoading) { reloadedFor.current = linkKey; loadAll(); }
      return;
    }
    if (isLoading || !displayedEscrows.some((e) => e.offerId === linkedOffer)) return;
    handledLink.current = linkKey;
    setSelectedOfferId(linkedOffer);
    if (!isMobile) setTimeout(() => document.getElementById(`offer-card-${linkedOffer}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
    const next = new URLSearchParams(searchParams);
    next.delete("offer");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadAll is recreated every render
  }, [linkedOffer, linkKey, displayedEscrows, isLoading, viewMode, searchParams, setSearchParams, isMobile]);

  // Phone: a trade opens as a full screen. The phone's Back button closes it, and the page behind does not scroll.
  const openTradeId = isMobile && selectedEscrow ? selectedEscrow.offerId : null;
  useEffect(() => {
    if (!openTradeId) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.history.pushState({ ...(window.history.state || {}), nxTrade: openTradeId }, "");
    let popped = false;
    const onPop = () => { popped = true; setSelectedOfferId(null); };
    window.addEventListener("popstate", onPop);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("popstate", onPop);
      if (!popped && window.history.state?.nxTrade === openTradeId) window.history.back();
    };
  }, [openTradeId]);

  // Phone: once an offer you opened from Offers becomes your trade (you accepted it), carry on in My trades.
  const navigate = useNavigate();
  useEffect(() => {
    if (!isMobile || viewMode !== "new" || !selectedOfferId || !account?.account) return;
    const e = allEscrows.find((x) => x.offerId === selectedOfferId);
    if (e && e.state !== "CREATED" && (e.buyer === account.account || e.seller === account.account)) {
      setSelectedOfferId(null);
      setTimeout(() => navigate(`/?offer=${encodeURIComponent(e.offerId)}`), 50);
    }
  }, [isMobile, viewMode, selectedOfferId, allEscrows, account?.account, navigate]);

  // On-chain reputation (minimal counters; score calculation off-chain)
  const { data: sellerRep } = useQuery({
    queryKey: ["reputation", selectedEscrow?.seller ?? "", selectedEscrow?.state],
    queryFn: () => getReputation(selectedEscrow!.seller),
    enabled: !!selectedEscrow?.seller,
  });
  const { data: buyerRep } = useQuery({
    queryKey: ["reputation", selectedEscrow?.buyer ?? "", selectedEscrow?.state],
    queryFn: () => getReputation(selectedEscrow!.buyer),
    enabled: !!selectedEscrow?.buyer,
  });

  // Can current user rate the selected COMPLETED trade?
  const { data: ratingCheck, refetch: refetchRatingCheck } = useQuery({
    queryKey: ["rating-check", selectedEscrow?.offerId, account?.account],
    queryFn: () =>
      selectedEscrow && account
        ? checkCanRate(selectedEscrow.offerId, account.account)
        : { canRate: false, alreadyRated: false },
    enabled: !!selectedEscrow && !!account && selectedEscrow.state === "COMPLETED",
  });

  // Per-trade ratings for COMPLETED escrow (UI/integrity: who rated whom)
  const { data: tradeRatings } = useQuery({
    queryKey: ["trade-ratings", selectedEscrow?.offerId],
    queryFn: () => (selectedEscrow ? fetchTradeRatings(selectedEscrow.offerId) : null),
    enabled: !!selectedEscrow && selectedEscrow.state === "COMPLETED",
  });

  const loadAll = async () => {
    setIsLoading(true);
    try {
      // v11 trades first; v10 history (completed trades of the old contract) is kept if it still reads
      const [v11, v10] = await Promise.all([
        loadV11Escrows(account?.account),
        listAllEscrows().catch((err) => { console.warn("[EscrowActions] v10 history not available:", err); return [] as Escrow[]; }),
      ]);
      const list = [...v11, ...v10];
      setAllEscrows(list);
      if (selectedOfferId && !list.some((e) => e.offerId === selectedOfferId)) {
        setSelectedOfferId(null);
      }
      // Refetch dispute state so "Disputed" shows correctly on cards and detail
      queryClient.invalidateQueries({ queryKey: ["dispute-check"] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[EscrowActions] loadAll failed:", error);
      toast.error("Failed to load offers", {
        description: message.length > 80 ? `${message.slice(0, 80)}…` : message,
      });
      setAllEscrows([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, [refreshTrigger]);

  /** Re-read one trade from the chain and update it in place (much faster than reloading every offer). */
  const refreshOne = async (offerId: string | undefined) => {
    if (!offerId) return null;
    const current = allEscrows.find((e) => e.offerId === offerId);
    if (current && isV11(current)) {
      const t = await readTrade(offerId).catch(() => null);
      if (t) setAllEscrows((list) => list.map((e) => (e.offerId === offerId && isV11(e) ? toV11Escrow(t, e.pool, e.networks, e.tRelease ?? 3600, e.arbiter) : e)));
      return t ? ({ state: t.state } as Escrow) : null;
    }
    const fresh = await readEscrow(offerId).catch(() => null);
    if (fresh) {
      setAllEscrows((list) => list.map((e) => (e.offerId === offerId
        ? { ...e, state: fresh.state, buyer: fresh.buyer, seller: fresh.seller, acceptedAt: fresh.acceptedAt, fundedAt: fresh.fundedAt, paidAt: fresh.paidAt }
        : e)));
    }
    return fresh;
  };

  // Live updates: the server announces each confirmed trade step ("trade-changed"), so the other side's
  // screen updates within seconds instead of waiting for a reload. A slow check of the open trade is the
  // fallback when the live connection is down.
  const liveRef = useRef({ selectedOfferId, allEscrows, loadAll, refreshOne });
  liveRef.current = { selectedOfferId, allEscrows, loadAll, refreshOne };
  useEffect(() => {
    const socket = getSocket();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = (msg: { offerId?: string } | undefined) => {
      const { selectedOfferId: open, refreshOne: one, loadAll: all } = liveRef.current;
      if (msg?.offerId && msg.offerId === open) void one(open);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void all();
        // a release, refund or deposit changes KDA balances: show the new one now, not at the next 30 s check
        queryClient.invalidateQueries({ queryKey: ["app-chain-balance"] });
      }, 800);
    };
    socket?.on("trade-changed", onChange);
    return () => { socket?.off("trade-changed", onChange); if (timer) clearTimeout(timer); };
  }, [queryClient]);
  useEffect(() => {
    if (!selectedOfferId) return;
    const t = setInterval(async () => {
      if (document.hidden) return;
      const { allEscrows: list, refreshOne: one } = liveRef.current;
      const before = list.find((e) => e.offerId === selectedOfferId)?.state;
      const fresh = await one(selectedOfferId);
      if (fresh && before && fresh.state !== before) void liveRef.current.loadAll();
    }, 15000);
    return () => clearInterval(t);
  }, [selectedOfferId]);

  const addTransaction = (action: string, requestKey: string) => {
    const offerId = selectedEscrow?.offerId;
    setTransactions(prev => [
      { action, requestKey, timestamp: new Date(), offerId },
      ...prev,
    ]);
    if (offerId) setTimeout(() => queryClient.invalidateQueries({ queryKey: ["trade-txs", offerId] }), 1500);
    queryClient.invalidateQueries({ queryKey: ["app-chain-balance"] });
  };

  const executeAction = async (
    actionName: string,
    buildTx: () => IUnsignedCommand
  ) => {
    if (!account) {
      toast.error("Please connect your wallet");
      return;
    }

    setActionLoading(actionName);
    // a deposit still saves its link after the chain answers: keep the page covered until then
    setTxLabel(txLabel(actionName, selectedEscrow), { hold: actionName === "Deposit" });
    // Yield so React paints the "Transaction in progress..." message before wallet/signing
    await new Promise((r) => setTimeout(r, 0));

    try {
      const tx = buildTx();
      const signedTx = await signTransaction(tx);
      const requestKey = await submitTransaction(signedTx);

      const txResult = await pollTransaction(requestKey);
      const res = txResult?.result;
      if (res?.status === "failure") {
        let errMsg = "Transaction failed on-chain";
        const e = res.error;
        if (typeof e === "string") errMsg = e;
        else if (e && typeof e === "object") {
          const o = e as Record<string, unknown>;
          errMsg = String(o.message ?? o.msg ?? o.info ?? o.detail ?? errMsg);
        }
        // the contract refused "I paid" because the block time was past the window
        if (isPayWindowPassed(errMsg)) errMsg = PAY_WINDOW_PASSED_MESSAGE;
        throw new Error(errMsg);
      }

      toast.success(`${actionName} succeeded`, {
        description: (
          <a
            href={getTxExplorerUrl(requestKey)}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: "underline", wordBreak: "break-all" }}
          >
            View on Explorer ↗
          </a>
        ),
      });

      addTransaction(actionName, requestKey);
      if (actionName === "Deposit" && selectedEscrow && account) {
        try {
          const signedCmd = await authProof(account.account, account.publicKey);
          await putFundTxRequestKey({
            offerId: selectedEscrow.offerId,
            requestKey,
            wallet: account.account,
            publicKey: account.publicKey,
            signedCmd,
          });
        } catch (e) {
          toast.error("Deposit saved; fund tx link could not be saved", {
            description: e instanceof Error ? e.message : String(e),
          });
        }
      }
      void refreshOne(selectedEscrow?.offerId);
      loadAll();
    } catch (error) {
      console.error(`${actionName} error:`, error);
      if (error instanceof TxUnresolvedError) {
        // the chain has not answered yet: the step may still go through, so never send it again
        toast.error("Still confirming on the chain", {
          duration: 30000,
          description: (
            <span>
              Do not send it again. Check the explorer link:{" "}
              <a href={getTxExplorerUrl(error.requestKey)} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline", wordBreak: "break-all" }}>{error.requestKey}</a>
            </span>
          ),
        });
        void refreshOne(selectedEscrow?.offerId);
        return;
      }
      let desc = error instanceof Error ? error.message : "Unknown error";
      if (actionName === "Deposit" && /Only KDA holder can deposit/i.test(desc)) {
        desc +=
          " Balance is not checked here — the chain verifies your signature against the coin guard for the KDA holder. Use the exact k: account shown as Seller; fund KDA on this app chain; multisig (keys-all) needs every key to sign. ";
        if (selectedEscrow?.seller) {
          desc += `Account on explorer: ${getAccountExplorerUrl(selectedEscrow.seller)}`;
        }
      }
      if (isInsufficientFunds(desc) && account) {
        const needed = actionName === "Deposit" && selectedEscrow ? selectedEscrow.amount : 0;
        // a v11 step pays its gas on the trade's chain (1 or 2), a v10 one on the app chain
        const shortfall = await (selectedEscrow && isV11(selectedEscrow)
          ? appChainShortfall(account.account, 0, selectedEscrow.trade.chain, gasKda(GAS_V11))
          : appChainShortfall(account.account, needed)).catch(() => null);
        if (shortfall) {
          toast.error(shortfall.title, { description: shortfall.description, duration: 20000 });
          return;
        }
      }
      toast.error(`${actionName} failed`, { description: desc });
    } finally {
      txFinished();
      setActionLoading(null);
    }
  };

  // Clear deleting offer state when any action finishes loading
  useEffect(() => {
    if (!actionLoading) setDeletingOfferId(null);
  }, [actionLoading]);

  // A confirmed email is required to trade (trade notices go there)
  const needsEmail = useNeedsTradeEmail();
  const [emailGateOpen, setEmailGateOpen] = useState(false);
  const terms = useTermsGate(() => handleAccept());
  const acceptLimit = selectedEscrow && selectedEscrow.state === "CREATED" && selectedEscrow.creator !== account?.account
    ? newTraderProblem(selectedEscrow.amount, myCompleted) : null;
  async function handleAccept() {
    if (!account || !selectedEscrow) return;
    if (needsEmail) { setEmailGateOpen(true); return; }
    if (acceptLimit) { toast.error(`Up to ${NEW_TRADER_MAX_KDA} KDA for now`, { description: acceptLimit }); return; }
    if (!(await terms.check())) return;
    executeAction("Accept Offer", () => 
      buildAcceptOfferTx(selectedEscrow.offerId, account.account, account.publicKey)
    );
  };

  const handleDeposit = async () => {
    if (!account || !selectedEscrow) return;
    // Show progress at once: the checks below take a moment before the wallet is asked.
    setActionLoading("Deposit");
    const stop = (title: string, description: string, duration?: number) => { setActionLoading(null); toast.error(title, { description, duration }); };
    // All checks in parallel (each is a network call; one after the other they added seconds)
    const payoutCheck = (async () => {
      try {
        const signedCmd = await authProof(account.account, account.publicKey);
        return await getPayout(selectedEscrow.offerId, { wallet: account.account, publicKey: account.publicKey, signedCmd });
      } catch { return undefined; /* server unreachable: do not block the deposit */ }
    })();
    const [fresh, payout, shortfall, vaultAccount] = await Promise.all([
      readEscrow(selectedEscrow.offerId),
      payoutCheck,
      // Wallets show the total across all chains; the deposit can only use chain 1. Stop with a
      // clear explanation instead of letting the chain answer "Insufficient funds".
      appChainShortfall(account.account, selectedEscrow.amount).catch(() => null),
      getEscrowVaultAccount(selectedEscrow.offerId),
    ]);
    if (!fresh) return stop("Deposit failed", "Could not read this escrow from chain. Check contract name/network.");
    if (fresh.state !== "ACCEPTED") return stop("Deposit failed", `Escrow must be ACCEPTED (now: ${fresh.state}).`);
    // readEscrow maps the on-chain KDA depositor to `seller` for both SELL and BUY offers.
    const kdaHolder = fresh.seller;
    if (!kdaHolder) return stop("Deposit failed", "On-chain data has no KDA holder yet; accept the offer first.");
    if (account.account !== kdaHolder) return stop("Deposit failed", `Deposit must be signed by the KDA holder. On-chain: ${kdaHolder}. Your wallet: ${account.account}.`);
    // The buyer must know where to pay before the KDA is locked (details lock at deposit).
    if (payout && payout.details.length === 0 && !isGiveaway(selectedEscrow)) return stop("Add where you get paid first", "Fill in \"Where you get paid\" in the trade details, so the buyer knows where to send the money. Then deposit.");
    if (shortfall) return stop(shortfall.title, shortfall.description, 20000);
    executeAction("Deposit", () =>
      buildDepositTx(selectedEscrow.offerId, fresh.amount, account.account, account.publicKey, vaultAccount)
    );
  };

  // Mark as Paid and Release first open a safety step (proof of payment / check your own account)
  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const handleMarkPaid = () => { if (account && selectedEscrow) setMarkPaidOpen(true); };
  const handleRelease = () => { if (account && selectedEscrow) setReleaseOpen(true); };

  /**
   * A trade taken for free (the gas station paid the take): when the buyer still has no KDA on the trade's chain for
   * gas, the station also pays their I paid, Cancel or Open dispute. "" = the buyer pays as usual.
   */
  const freeStation = async (e: V11Escrow): Promise<string> => {
    if (!account || account.account !== e.trade.buyer) return "";
    const short = await appChainShortfall(account.account, 0, e.trade.chain, gasKda(GAS_V11)).catch(() => null);
    if (!short || !(await isFreeTrade(e.offerId))) return "";
    return (await readFreeTakes(account.account, e.trade.chain))?.station ?? "";
  };
  const buyerStep = async (e: V11Escrow, which: FreeStep, paid: () => IUnsignedCommand) => {
    const station = await freeStation(e);
    return station && account ? () => buildFreeStepTx(which, e.offerId, account.account, account.publicKey, station) : paid;
  };

  const doMarkPaid = async () => {
    if (!account || !selectedEscrow) return;
    if (isV11(selectedEscrow)) {
      const e = selectedEscrow;
      executeAction("Mark Paid", await buyerStep(e, "mark-paid", () => buildV11MarkPaidTx(e.offerId, account.account, account.publicKey)));
      return;
    }
    executeAction("Mark Paid", () =>
      buildMarkPaidTx(selectedEscrow.offerId, account.account, account.publicKey)
    );
  };

  // v11: the buyer cancels an unpaid trade (KDA back to the pool); the seller takes the KDA back after the window.
  // Both ask once in the app's own dialog (not the browser's confirm box) before the wallet is opened.
  const [confirm, setConfirm] = useState<{ title: string; body: string; confirmLabel: string; run: () => void; warning?: string; ack?: string } | null>(null);
  const handleV11Cancel = () => {
    if (!account || !selectedEscrow || !isV11(selectedEscrow)) return;
    const e = selectedEscrow;
    setConfirm({
      title: "Cancel this trade?", confirmLabel: "Cancel the trade",
      body: `The ${kdaAmount(e.amount)} KDA goes back to the seller's pool. Only do this if you have not paid.`,
      run: async () => executeAction("Cancel", await buyerStep(e, "cancel", () => buildV11CancelTx(e.offerId, account.account, account.publicKey))),
    });
  };
  // Before the seller takes the KDA back, the server looks at the seller's address for payments that arrived during
  // the trade (the buyer may have paid without tapping I paid). A payment that covers the amount holds the button:
  // the seller must tick that it is not from this trade before going on.
  const handleV11Refund = async () => {
    if (!account || !selectedEscrow || !isV11(selectedEscrow)) return;
    const e = selectedEscrow;
    setActionLoading("Take KDA back");
    let inc: Awaited<ReturnType<typeof getIncoming>> = null;
    try {
      const signedCmd = await authProof(account.account, account.publicKey);
      inc = await getIncoming(e.offerId, { wallet: account.account, publicKey: account.publicKey, signedCmd });
    } catch { /* no check: the standard warning below */ }
    finally { setActionLoading(null); }
    const cur = e.trade.currency;
    const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const list = (inc?.payments ?? []).map((x) => `${x.amount} ${cur} on ${networkLabel(x.network)} at ${when(x.at)}`).join("; ");
    const base = "Taking the KDA back cannot be undone. If the buyer did pay, release instead.";
    setConfirm({
      title: `Take ${kdaAmount(e.amount)} KDA back?`, confirmLabel: "Take the KDA back",
      body: inc?.hold ? base
        : inc?.payments.length ? `${base} Payments smaller than this trade's ${exactPay(e.trade.payAmount)} ${cur} reached your address since it started: ${list}. Check whether they are from this buyer.`
        : inc?.checked && !inc.failed?.length ? `No ${cur} payment reached your receiving address since this trade started. ${base}`
        : `Check your account first. ${base}`,
      warning: inc?.hold ? `A payment that covers this trade reached your address since it started: ${list}. It is probably this buyer's payment: release the KDA instead. If the buyer says they paid, ask in the chat or open a dispute.` : undefined,
      ack: inc?.hold ? "I checked: this payment is not for this trade." : undefined,
      run: () => executeAction("Take KDA back", () => buildV11TimeoutRefundTx(e.offerId, account.account, account.publicKey)),
    });
  };
  // v11: a dispute is a chain step (open-dispute) plus the arbiter's record on our server
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState("");
  const handleV11Dispute = async () => {
    if (!account || !selectedEscrow || !isV11(selectedEscrow)) return;
    const reason = disputeReason.trim();
    if (!reason) { toast.error("Say what went wrong"); return; }
    setDisputeOpen(false);
    const e = selectedEscrow;
    setActionLoading("Open dispute");
    setTxLabel(txLabel("Open dispute", e));
    await new Promise((r) => setTimeout(r, 0));
    try {
      const tx = (await buyerStep(e, "open-dispute", () => buildV11OpenDisputeTx(e.offerId, account.account, account.publicKey)))();
      const signedTx = await signTransaction(tx);
      const requestKey = await submitTransaction(signedTx);
      const res = (await pollTransaction(requestKey))?.result;
      if (res?.status === "failure") {
        const err = res.error as { message?: string } | string | undefined;
        throw new Error(typeof err === "string" ? err : err?.message || "Transaction failed on-chain");
      }
      addTransaction("Open dispute", requestKey);
      try {
        const signedCmd = await authProof(account.account, account.publicKey);
        await openDispute({ offerId: e.offerId, openedBy: account.account === e.buyer ? "buyer" : "seller", reason, wallet: account.account, publicKey: account.publicKey, signedCmd });
        toast.success("Dispute opened: the arbiter has been notified");
        setDisputeTab("dispute");
        queryClient.invalidateQueries({ queryKey: ["dispute-check"] });
      } catch {
        toast.warning("Moved to dispute on chain, but the arbiter record could not be created", { description: `Contact support with trade ID: ${e.offerId}` });
      }
      setDisputeReason("");
      void refreshOne(e.offerId);
      loadAll();
    } catch (error) {
      toast.error("Open dispute failed", { description: error instanceof Error ? error.message : "Unknown error" });
    } finally {
      txFinished();
      setActionLoading(null);
    }
  };

  const doRelease = async () => {
    if (!account || !selectedEscrow) return;
    if (isV11(selectedEscrow)) {
      executeAction("Release", () => buildV11ReleaseTx(selectedEscrow.offerId, account.account, account.publicKey));
      return;
    }
    const releaseRecipient = selectedEscrow.side === "SELL" ? selectedEscrow.buyer! : selectedEscrow.creator;
    const vaultAccount = await getEscrowVaultAccount(selectedEscrow.offerId);
    executeAction("Release", () =>
      buildReleaseTx(selectedEscrow.offerId, account.account, account.publicKey, releaseRecipient, selectedEscrow.amount, vaultAccount)
    );
  };

  const handleRefund = async () => {
    if (!account || !selectedEscrow) return;
    const refundRecipient = selectedEscrow.side === "SELL" ? selectedEscrow.creator : selectedEscrow.buyer;
    if (!refundRecipient) return;
    const vaultAccount = await getEscrowVaultAccount(selectedEscrow.offerId);
    executeAction("Refund", () =>
      buildRefundTx(selectedEscrow.offerId, account.account, account.publicKey, refundRecipient, selectedEscrow.amount, vaultAccount)
    );
  };


  const handleDeleteOffer = (offerId: string) => {
    if (!account) {
      toast.error("Please connect your wallet");
      return;
    }
    setDeletingOfferId(offerId);
    toast.info("Deleting offer…", { description: "Confirm in your wallet. This may take a moment." });
    executeAction("Delete Offer", () =>
      buildDeleteOfferTx(offerId, account.account, account.publicKey)
    );
    if (selectedOfferId === offerId) setSelectedOfferId(null);
  };

  const handleCancelAcceptedOffer = () => {
    if (!account || !selectedEscrow) return;
    executeAction("Cancel Offer", () =>
      buildCancelAcceptedOfferTx(selectedEscrow.offerId, account.account, account.publicKey)
    );
  };

  const handleTimeoutAcceptedClose = () => {
    if (!account || !selectedEscrow) return;
    executeAction("Close (T1 Expired)", () =>
      buildTimeoutAcceptedCloseTx(selectedEscrow.offerId, account.account, account.publicKey)
    );
  };

  const handleTimeoutFundedRefund = async () => {
    if (!account || !selectedEscrow) return;
    const refundTo = selectedEscrow.side === "SELL" ? selectedEscrow.creator : selectedEscrow.buyer;
    if (!refundTo) return;
    const vaultAccount = await getEscrowVaultAccount(selectedEscrow.offerId);
    executeAction("Timeout: Refund (T2)", () =>
      buildTimeoutFundedRefundTx(selectedEscrow.offerId, account.account, account.publicKey, refundTo, selectedEscrow.amount, vaultAccount)
    );
  };

  const handleTimeoutPaidDispute = async () => {
    if (!account || !selectedEscrow) return;

    setActionLoading("Timeout: Dispute (T3)");
    setTxLabel(txLabel("Timeout: Dispute (T3)", selectedEscrow));
    await new Promise((r) => setTimeout(r, 0));

    try {
      const tx = buildTimeoutPaidDisputeTx(selectedEscrow.offerId, account.account, account.publicKey);
      const signedTx = await signTransaction(tx);
      const requestKey = await submitTransaction(signedTx);
      const txResult = await pollTransaction(requestKey);
      const res = txResult?.result;
      if (res?.status === "failure") {
        let errMsg = "Transaction failed on-chain";
        const e = res.error;
        if (typeof e === "string") errMsg = e;
        else if (e && typeof e === "object") {
          const o = e as Record<string, unknown>;
          errMsg = String(o.message ?? o.msg ?? o.info ?? o.detail ?? errMsg);
        }
        // the contract refused "I paid" because the block time was past the window
        if (isPayWindowPassed(errMsg)) errMsg = PAY_WINDOW_PASSED_MESSAGE;
        throw new Error(errMsg);
      }

      addTransaction("Timeout: Dispute (T3)", requestKey);

      // Atomically create off-chain dispute record so arbiter panel is functional
      try {
        const signedCmd = await authProof(account.account, account.publicKey);

        await openDispute({
          offerId: selectedEscrow.offerId,
          openedBy: account.account === selectedEscrow.buyer ? "buyer" : "seller",
          reason: "Seller did not release within T3 timeout",
          wallet: account.account,
          publicKey: account.publicKey,
          signedCmd,
        });

        toast.success("Dispute opened — arbiter has been notified", {
          description: (
            <a href={getTxExplorerUrl(requestKey)} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline", wordBreak: "break-all" }}>
              View on Explorer ↗
            </a>
          ),
        });
        setDisputeTab("dispute");
        queryClient.invalidateQueries({ queryKey: ["dispute-check"] });
      } catch (disputeErr) {
        toast.warning("Moved to dispute on-chain, but arbiter record could not be created", {
          description: `Please contact support with offer ID: ${selectedEscrow.offerId}`,
        });
      }

      loadAll();
    } catch (error) {
      console.error("Timeout: Dispute (T3) error:", error);
      toast.error("Timeout: Dispute (T3) failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setActionLoading(null);
    }
  };

  // v11 trade: what this wallet can do now (the v10 flags below are all off for it)
  const v11 = selectedEscrow && isV11(selectedEscrow) ? (selectedEscrow as V11Escrow) : null;
  const t11 = v11?.trade;
  const meIsBuyer11 = !!t11 && !!account && account.account === t11.buyer;
  const meIsSeller11 = !!t11 && !!account && account.account === t11.seller;
  const payExpired11 = !!t11 && t11.state === "FUNDED" && isStepExpired(t11.fundedAt, t11.payWindow);
  // "I paid" checks the device clock but the contract checks the block time: for the buyer the window closes
  // PAY_MARGIN_S early, so a tap just before the end is not refused by the chain
  const payLeft11 = t11?.state === "FUNDED" && t11.fundedAt ? getRemainingSeconds(t11.fundedAt, t11.payWindow) ?? 0 : 0;
  const payClosedForBuyer11 = payExpired11 || (!!t11 && t11.state === "FUNDED" && payLeft11 <= PAY_MARGIN_S);
  // after the window the buyer has a 30-minute grace period to tap I paid or dispute; only then can the seller take the KDA back
  const takeBackIn11 = t11?.state === "FUNDED" ? takeBackLeft(t11) : 0;
  const inGrace11 = payExpired11 && takeBackIn11 > 0;
  const minutes = (sec: number) => `${Math.max(1, Math.ceil(sec / 60))} min`;
  const releaseExpired11 = !!t11 && t11.state === "PAID" && isStepExpired(t11.paidAt, v11?.tRelease ?? 3600);
  const canV11MarkPaid = !!t11 && t11.state === "FUNDED" && meIsBuyer11 && takeBackIn11 > PAY_MARGIN_S;
  const canV11Cancel = !!t11 && t11.state === "FUNDED" && meIsBuyer11;
  const canV11Release = !!t11 && (t11.state === "FUNDED" || t11.state === "PAID") && meIsSeller11;
  const canV11Refund = !!t11 && t11.state === "FUNDED" && meIsSeller11 && takeBackIn11 <= 0;
  // the buyer disputes after "I paid", or once the pay window closed (paid, but too late to tap); the seller after "I paid"
  const canV11Dispute = !!t11 && ((meIsBuyer11 && (t11.state === "PAID" || (t11.state === "FUNDED" && payClosedForBuyer11))) || (meIsSeller11 && t11.state === "PAID"));

  const canAccept = !v11 && selectedEscrow?.state === "CREATED" && account?.account !== selectedEscrow?.creator;
  // KDA depositor (contract): SELL → creator; BUY → on-chain `buyer` (accepter). readEscrow maps that to `seller` always.
  const canDeposit = !v11 &&
    selectedEscrow?.state === "ACCEPTED" &&
    !!selectedEscrow?.seller &&
    account?.account === selectedEscrow.seller;
  const canMarkPaid = !v11 && selectedEscrow?.state === "FUNDED" &&
    (selectedEscrow?.side === "SELL" ? account?.account === selectedEscrow?.buyer : account?.account === selectedEscrow?.creator);
  const canRelease = !v11 && (selectedEscrow?.state === "PAID" || selectedEscrow?.state === "DISPUTED") &&
    (account?.account === selectedEscrow?.seller || account?.account === selectedEscrow?.arbiter) &&
    (selectedEscrow?.state !== "DISPUTED" || account?.account === selectedEscrow?.arbiter);
  const canRefund = !v11 && (selectedEscrow?.state === "FUNDED" || selectedEscrow?.state === "PAID" || selectedEscrow?.state === "DISPUTED") &&
    account?.account === selectedEscrow?.arbiter &&
    (selectedEscrow?.side === "SELL" || !!selectedEscrow?.buyer);
  const canCancelAcceptedOffer = !v11 && selectedEscrow?.state === "ACCEPTED" && account?.account === selectedEscrow?.creator && !isStepExpired(selectedEscrow.acceptedAt, T1_SECONDS);
  const canTimeoutAcceptedClose = !v11 && selectedEscrow?.state === "ACCEPTED" && !!account?.account && isStepExpired(selectedEscrow.acceptedAt, T1_SECONDS);
  const canTimeoutFundedRefund = !v11 && selectedEscrow?.state === "FUNDED" && account?.account === selectedEscrow?.seller && isStepExpired(selectedEscrow.fundedAt, T2_SECONDS);
  const canTimeoutPaidDispute = !v11 && selectedEscrow?.state === "PAID" && !!account?.account && isStepExpired(selectedEscrow.paidAt, T3_SECONDS);

  // When dispute is open/under review, disable all action buttons for seller and buyer (arbiter can still act)
  const isInDispute =
    !!existingDispute && (existingDispute.status === "OPEN" || existingDispute.status === "UNDER_REVIEW");
  const isSellerOrBuyer =
    !!selectedEscrow && !!account &&
    (account.account === selectedEscrow.seller || account.account === selectedEscrow.buyer);
  const isInDisputeForParty = isInDispute && isSellerOrBuyer;

  const canAcceptFinal = canAccept && !isInDisputeForParty;
  // Deposit is a seller-mode action (KDA holder); hide in buyer-mode marketplace view.
  const canDepositFinal = canDeposit && !isInDisputeForParty && role === "seller";
  const canMarkPaidFinal = (canMarkPaid || canV11MarkPaid) && !isInDisputeForParty;
  const canReleaseFinal = (canRelease || canV11Release) && !isInDisputeForParty;
  const canTimeoutFundedRefundFinal = canTimeoutFundedRefund && !isInDisputeForParty;
  const canTimeoutPaidDisputeFinal = canTimeoutPaidDispute && !isInDisputeForParty;
  const canV11CancelFinal = canV11Cancel && !isInDisputeForParty;
  const canV11RefundFinal = canV11Refund && !isInDisputeForParty;
  const canV11DisputeFinal = canV11Dispute && !isInDisputeForParty;
  // auto-release: the platform's agent releases once it sees the exact payment, so "I paid" stays as a fallback only
  const { data: auto11 } = useTradeAuto(v11);
  const agentReleases11 = !!v11 && isAutoActive(auto11);

  const isTerminal = !!selectedEscrow && PAST_TERMINAL_STATES.includes(selectedEscrow.state as (typeof PAST_TERMINAL_STATES)[number]) || selectedEscrow?.state === "DELETED";

  const isCompletedTrade = selectedEscrow?.state === "COMPLETED" && selectedEscrow?.buyer;
  const isPartyToTrade = isCompletedTrade && account && (account.account === selectedEscrow.buyer || account.account === selectedEscrow.seller);
  // Show "Register completion to rate" when we're a party, not already rated, and (check still loading OR backend says can't rate yet)
  const needsRegisterCompletion = isPartyToTrade && !ratingCheck?.alreadyRated && (ratingCheck === undefined || !ratingCheck.canRate);
  const canRateTrade = isPartyToTrade && ratingCheck?.canRate === true && !ratingCheck?.alreadyRated;
  const alreadyRated = isPartyToTrade && ratingCheck?.alreadyRated === true;
  const counterpartyWallet = isCompletedTrade && account
    ? (account.account === selectedEscrow.buyer ? selectedEscrow.seller : selectedEscrow.buyer)
    : null;

  // One button: records the completed trade with our server first if needed (no separate step), then opens the rating.
  const handleRateTrade = async () => {
    if (!account || !selectedEscrow?.buyer) return;
    if (canRateTrade) { setShowRatingDialog(true); return; }
    setRegisteringCompletion(true);
    try {
      const signedCmd = await authProof(account.account, account.publicKey);
      await registerCompletion({
        offerId: selectedEscrow.offerId,
        buyerWallet: selectedEscrow.buyer,
        sellerWallet: selectedEscrow.seller,
        wallet: account.account,
        publicKey: account.publicKey,
        signedCmd,
      });
      const check = await refetchRatingCheck();
      if (check.data?.alreadyRated) toast.info("You already rated this trade.");
      else setShowRatingDialog(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open the rating");
    } finally {
      setRegisteringCompletion(false);
    }
  };

  // Phone: the one step this person must take sits in a bar at the bottom of the trade screen
  const mobilePrimary = !isMobile || !selectedEscrow || isTerminal || !isConnected ? null
    : canAcceptFinal ? { label: "Accept Offer", busy: "Accept Offer", Icon: UserPlus, run: handleAccept }
    : canDepositFinal ? { label: `Deposit ${kdaAmount(selectedEscrow.amount)} KDA`, busy: "Deposit", Icon: Lock, run: handleDeposit }
    : v11 && canMarkPaidFinal && !agentReleases11 ? { label: "I paid", busy: "Mark Paid", Icon: DollarSign, run: handleMarkPaid }
    : v11 && canReleaseFinal && t11?.state === "PAID" ? { label: "Release", busy: "Release", Icon: Unlock, run: handleRelease }
    : v11 && canV11RefundFinal ? { label: "Take KDA back", busy: "Take KDA back", Icon: RotateCcw, run: handleV11Refund }
    : v11 ? null
    : canMarkPaidFinal ? { label: "Mark as Paid", busy: "Mark Paid", Icon: DollarSign, run: handleMarkPaid }
    : canReleaseFinal ? { label: "Release to Buyer", busy: "Release", Icon: Unlock, run: handleRelease }
    : null;
  /** v11 buttons, by role and state (the one in the phone's bottom bar is left out there) */
  const v11Buttons = !v11 || isTerminal || !isConnected ? [] : [
    canMarkPaidFinal && (!isMobile || agentReleases11) ? { key: "paid", label: "I paid", busy: "Mark Paid", Icon: DollarSign, run: handleMarkPaid, variant: agentReleases11 ? "outline" as const : "default" as const,
      note: inGrace11 ? `The payment window has closed. Already sent the money? Tap I paid now (${minutes(takeBackIn11)} left).`
        : agentReleases11 ? "Sent the payment? Tap I paid. It's optional with auto-release, but it protects you if the payment isn't detected." : undefined } : null,
    canReleaseFinal && (!isMobile || t11?.state !== "PAID") ? { key: "release", label: t11?.state === "FUNDED" ? "Release now (buyer paid)" : "Release", busy: "Release", Icon: Unlock, run: handleRelease, variant: t11?.state === "PAID" ? "default" as const : "outline" as const,
      note: inGrace11 && meIsSeller11 ? `Only if the money is already in your account. The buyer's window closed; Take KDA back opens in ${minutes(takeBackIn11)} if no payment arrives.`
        : t11?.state === "FUNDED" ? "Only if the money is already in your account." : undefined } : null,
    canV11RefundFinal && !isMobile ? { key: "refund", label: "Take KDA back", busy: "Take KDA back", Icon: RotateCcw, run: handleV11Refund, variant: "outline" as const, note: "The payment window and the buyer's 30-minute grace period have passed." } : null,
    canV11CancelFinal ? { key: "cancel", label: "Cancel", busy: "Cancel", Icon: XCircle, run: handleV11Cancel, variant: "outline" as const, note: "Before paying only." } : null,
    canV11DisputeFinal ? { key: "dispute", label: "Open dispute", busy: "Open dispute", Icon: AlertTriangle, run: () => setDisputeOpen(true), variant: "outline" as const,
      note: releaseExpired11 ? "The release window closed." : t11?.state === "FUNDED" ? `Paid but the seller hasn't released? Open a dispute${takeBackIn11 > 0 ? ` within ${minutes(takeBackIn11)}` : " now"}, before the seller can take the KDA back.` : undefined } : null,
  ].filter((b): b is NonNullable<typeof b> => !!b);
  const closeTrade = () => setSelectedOfferId(null);
  const shownState = (e: Escrow) =>
    existingDispute && (existingDispute.status === "OPEN" || existingDispute.status === "UNDER_REVIEW") ? "DISPUTED" : e.state;

  const detailTabs = selectedEscrow ? (
            <Tabs value={disputeTab} onValueChange={setDisputeTab}>
              <TabsList className={isMobile ? "grid w-full grid-cols-3" : undefined}>
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="chat" className="gap-2">
                  <MessageCircle className="h-4 w-4" />
                  Chat
                </TabsTrigger>
                <TabsTrigger value="dispute" className="gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Dispute
                </TabsTrigger>
              </TabsList>

              <TabsContent value="details" className="space-y-6 mt-4">
            {/* Timed step countdown (contract is source of truth) */}
            {!isMobile && (selectedEscrow.state === "ACCEPTED" || selectedEscrow.state === "FUNDED" || selectedEscrow.state === "PAID") && (
              <TradeTimer escrow={selectedEscrow} me={account?.account} />
            )}

            {/* Details Grid */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className={isMobile ? "hidden" : undefined}>
                <Label className="text-muted-foreground">Side</Label>
                <p className="font-semibold text-lg">
                  {selectedEscrow.side === "SELL" ? "Selling" : "Buying"} KDA
                </p>
              </div>
              <div>
                <Label className="text-muted-foreground">Price</Label>
                <p className="font-mono text-2xl font-bold text-primary">
                  {isGiveaway(selectedEscrow) ? "Free" : v11 ? <>
                  {formatFiat(selectedEscrow.price, "USD")} {selectedEscrow.fiatCurrency} <span className="text-base">per KDA</span>
                  </> : <>
                  {currencyPrefix(selectedEscrow.fiatCurrency)}
                  {formatFiat(selectedEscrow.price, selectedEscrow.fiatCurrency)} <span className="text-base">per KDA</span>
                  </>}
                </p>
                {!isGiveaway(selectedEscrow) && !(v11 && isInstant(v11.trade)) && <MarketTag price={selectedEscrow.price} currency={v11 ? "USD" : selectedEscrow.fiatCurrency} className="text-sm" />}
              </div>
              <div>
                <Label className="text-muted-foreground">{v11 ? "Amount" : "Available Amount"}</Label>
                <p className="font-mono text-xl font-bold">
                  {isMobile ? kdaAmount(selectedEscrow.amount) : selectedEscrow.amount.toFixed(8)} <span className="text-base">KDA</span>
                </p>
                {v11 && !isInstant(v11.trade) && !isGiveawayPool(v11.trade) && <p className="text-xs text-muted-foreground">Payment window: {windowLabel(v11.trade.payWindow)}</p>}
              </div>
              <div className="sm:col-span-2">
                <Label className="text-muted-foreground">{v11 ? (v11.side === "SELL" ? "The buyer pays" : "You get paid") : "Total Value"}</Label>
                <div className="mt-1 rounded-lg border-2 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-700 px-4 py-3">
                  <p className="font-mono text-2xl font-bold text-emerald-800 dark:text-emerald-200">
                    {agentReleases11 ? `${auto11?.amount} ${v11?.trade.currency}` : tradeTotal(selectedEscrow)}
                  </p>
                  <p className="mt-3 text-sm text-muted-foreground leading-snug">
                    {v11 ? (
                      isGiveawayPool(v11.trade) ? "Free giveaway: the KDA went straight to the receiver when they claimed it."
                      : isInstant(v11.trade) ? `Instant: ${payText(v11.trade)} and the KDA moved in the same transaction.`
                      : agentReleases11 ? `Auto-release: the buyer sends exactly ${auto11?.amount} ${v11.trade.currency} (the last digits identify the payment) and the KDA is released when it arrives.`
                      : "The buyer sends exactly this amount to the address below from a wallet they control, then presses I paid. The seller checks their own account and releases."
                    ) : isGiveaway(selectedEscrow)
                      ? "Free giveaway: there is nothing to pay. Once the seller has locked the KDA, the receiver taps Mark as Paid (no screenshot needed) and the seller releases the KDA."
                      : "Kadena buyer must send this exact amount to the seller using the selected payment method. After sending the payment, the buyer must upload a screenshot of the transaction confirmation in the chat."}
                  </p>
                </div>
              </div>
              <div className="sm:col-span-2 space-y-4">
                {!isGiveaway(selectedEscrow) && <>
                <ProofCard escrow={selectedEscrow} />
                {v11 && !isInstant(v11.trade) && <AutoReleaseCard escrow={v11} />}
                {v11 && v11.side === "SELL" ? <PoolPayoutCard escrow={v11} /> : (!v11 || !isInstant(v11.trade)) && (
                <PayoutCard
                  escrow={selectedEscrow}
                  total={agentReleases11 ? `${auto11?.amount} ${v11?.trade.currency}` : tradeTotal(selectedEscrow)}
                />
                )}
                </>}
              </div>
              <div className={isMobile ? "hidden" : undefined}>
                <Label className="text-muted-foreground">Amount</Label>
                <p className="text-sm font-mono">{selectedEscrow.amount.toFixed(4)} KDA</p>
              </div>
              <div>
                <Label className="text-muted-foreground">Payment Methods</Label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {(() => {
                    try {
                      const methods = JSON.parse(selectedEscrow.paymentMethod || "[]");
                      return methods.map((m: string, idx: number) => (
                        <Badge key={idx} variant="outline">{m}</Badge>
                      ));
                    } catch {
                      return <Badge variant="outline">{selectedEscrow.paymentMethod || "N/A"}</Badge>;
                    }
                  })()}
                </div>
              </div>
              <div>
                <Label className="text-muted-foreground">Seller</Label>
                <ProfileSummaryView wallet={selectedEscrow.seller} summary={profileMap[selectedEscrow.seller]} />
                {sellerRep && (
                  <p className="text-xs text-muted-foreground mt-1">
                    On-chain: {sellerRep.successfulTrades}/{sellerRep.totalTrades} completed, {sellerRep.disputesCount} disputes
                  </p>
                )}
                <RatingDisplay summary={ratingSummaryMap[selectedEscrow.seller]} variant="full" className="mt-2" />
              </div>
              <div>
                <Label className="text-muted-foreground">Buyer</Label>
                {selectedEscrow.buyer ? (
                  <>
                    <ProfileSummaryView wallet={selectedEscrow.buyer} summary={profileMap[selectedEscrow.buyer]} />
                    {buyerRep && (
                      <p className="text-xs text-muted-foreground mt-1">
                        On-chain: {buyerRep.successfulTrades}/{buyerRep.totalTrades} completed, {buyerRep.disputesCount} disputes
                      </p>
                    )}
                    <RatingDisplay summary={ratingSummaryMap[selectedEscrow.buyer]} variant="full" className="mt-2" />
                  </>
                ) : (
                  <span className="text-muted-foreground italic text-sm">Not yet accepted</span>
                )}
              </div>
              <div>
                <Label className="text-muted-foreground">Arbiter</Label>
                <ProfileSummaryView wallet={selectedEscrow.arbiter} summary={profileMap[selectedEscrow.arbiter]} />
              </div>
            </div>

            {/* Action Buttons */}
            {!isTerminal && isConnected && (
              <div className="flex flex-col gap-3 pt-4 border-t border-border">
                {CRITICAL_ACTION_LOADING.includes(actionLoading as (typeof CRITICAL_ACTION_LOADING)[number]) && (
                  <Alert className="border-primary/50 bg-primary/5">
                    <Info className="h-4 w-4" />
                    <AlertTitle>Transaction in progress</AlertTitle>
                    <AlertDescription>{TX_CONFIRM_MESSAGE}</AlertDescription>
                  </Alert>
                )}
                {v11Buttons.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {v11Buttons.map((b) => (
                      <div key={b.key} className="flex flex-col gap-1">
                        <Button onClick={b.run} disabled={!!actionLoading} variant={b.variant} className={`h-12 gap-2 ${b.key === "cancel" ? "border-destructive text-destructive hover:bg-destructive/10" : b.key === "dispute" ? "border-amber-500 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300" : b.key === "release" && b.variant === "default" ? "bg-success hover:bg-success/90" : ""}`}>
                          {actionLoading === b.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <b.Icon className="h-4 w-4" />}
                          {b.label}
                        </Button>
                        {b.note && <p className="text-xs text-muted-foreground">{b.note}</p>}
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-3">

{canAcceptFinal && !isMobile && (
                  <Button 
                    onClick={handleAccept}
                    disabled={!!actionLoading}
                    className="gap-2"
                  >
                    {actionLoading === "Accept Offer" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <UserPlus className="h-4 w-4" />
                    )}
                    Accept Offer
                  </Button>
                )}

                {canCancelAcceptedOffer && (
                  <Button
                    onClick={handleCancelAcceptedOffer}
                    disabled={!!actionLoading}
                    variant="outline"
                    className="gap-2 border-destructive text-destructive hover:bg-destructive/10"
                  >
                    {actionLoading === "Cancel Offer" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <XCircle className="h-4 w-4" />
                    )}
                    Cancel Offer
                  </Button>
                )}

                {canTimeoutAcceptedClose && (
                  <Button
                    onClick={handleTimeoutAcceptedClose}
                    disabled={!!actionLoading}
                    variant="outline"
                    className="gap-2 border-amber-500 text-amber-600 hover:bg-amber-500/10"
                  >
                    {actionLoading === "Close (T1 Expired)" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <XCircle className="h-4 w-4" />
                    )}
                    Close offer (seller did not fund in time)
                  </Button>
                )}

                {canDepositFinal && !isMobile && (
                  <Button
                    onClick={handleDeposit}
                    disabled={!!actionLoading}
                    className="gap-2"
                  >
                    {actionLoading === "Deposit" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Lock className="h-4 w-4" />
                    )}
                    Deposit {selectedEscrow.amount.toFixed(4)} KDA
                  </Button>
                )}

                {canDepositFinal && appChainBalance !== undefined && (
                  <p className={`basis-full text-xs ${appChainBalance < selectedEscrow.amount + TX_GAS_KDA ? "text-destructive" : "text-muted-foreground"}`}>
                    Your chain {CHAIN_ID} balance: {appChainBalance.toLocaleString("en-US", { maximumFractionDigits: 4 })} KDA
                    {appChainBalance < selectedEscrow.amount + TX_GAS_KDA
                      ? ` (not enough: this deposit needs ${(selectedEscrow.amount + TX_GAS_KDA).toLocaleString("en-US", { maximumFractionDigits: 4 })} KDA on chain ${CHAIN_ID}. If your KDA is on another chain, move it to chain ${CHAIN_ID} in your wallet first.)`
                      : " (enough for this deposit)"}
                  </p>
                )}

                {canMarkPaidFinal && !v11 && !isMobile && (
                  <Button 
                    onClick={handleMarkPaid}
                    disabled={!!actionLoading}
                    variant="secondary"
                    className="gap-2"
                  >
                    {actionLoading === "Mark Paid" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <DollarSign className="h-4 w-4" />
                    )}
                    Mark as Paid
                  </Button>
                )}

                {canReleaseFinal && !v11 && !isMobile && (
                  <Button 
                    onClick={handleRelease}
                    disabled={!!actionLoading}
                    className="gap-2 bg-success hover:bg-success/90"
                  >
                    {actionLoading === "Release" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Unlock className="h-4 w-4" />
                    )}
                    Release to Buyer
                  </Button>
                )}

                {canRefund && (
                  <Button 
                    onClick={handleRefund}
                    disabled={!!actionLoading}
                    variant="destructive"
                    className="gap-2"
                  >
                    {actionLoading === "Refund" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                    {selectedEscrow?.side === "SELL" ? "Refund to Seller" : "Refund to Buyer"}
                  </Button>
                )}

                {canTimeoutFundedRefundFinal && (
                  <Button 
                    onClick={handleTimeoutFundedRefund}
                    disabled={!!actionLoading}
                    variant="outline"
                    className="gap-2"
                  >
                    {actionLoading === "Timeout: Refund (T2)" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                    Refund (buyer did not mark paid in time)
                  </Button>
                )}

                {canTimeoutPaidDisputeFinal && (
                  <Button 
                    onClick={handleTimeoutPaidDispute}
                    disabled={!!actionLoading}
                    variant="outline"
                    className="gap-2 border-amber-500 text-amber-600 hover:bg-amber-500/10"
                  >
                    {actionLoading === "Timeout: Dispute (T3)" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <AlertTriangle className="h-4 w-4" />
                    )}
                    Move to dispute (seller did not release in time)
                  </Button>
                )}
                </div>
              </div>
            )}

            {isTerminal && (
              <div className="pt-4 border-t border-border space-y-3">
                <p className="text-center text-muted-foreground">{v11 ? nextStep(v11, account?.account, false) : "This escrow has been finalized."}</p>
                {isPartyToTrade && (
                  <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
                    <p className="text-sm font-medium text-center">Leave a rating for this trade</p>
                    {(needsRegisterCompletion || canRateTrade) && counterpartyWallet && (
                      <div className="flex justify-center">
                        <Button
                          variant="default"
                          size="sm"
                          onClick={handleRateTrade}
                          disabled={registeringCompletion}
                          className="gap-2"
                        >
                          {registeringCompletion ? <Loader2 className="h-4 w-4 animate-spin" /> : <Star className="h-4 w-4" />}
                          Rate this trade
                        </Button>
                      </div>
                    )}
                    {alreadyRated && (
                      <p className="text-center text-sm text-muted-foreground">You already rated this trade.</p>
                    )}
                  </div>
                )}
                {tradeRatings && tradeRatings.ratingCount > 0 && (
                  <div className="text-sm border rounded-md p-3 bg-muted/50">
                    <p className="font-medium text-muted-foreground mb-2">Ratings for this trade</p>
                    <ul className="space-y-1">
                      {tradeRatings.ratings.map((r, i) => (
                        <li key={i} className="flex items-center gap-2">
                          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                          <span>
                            {profileMap[r.raterWallet]?.username || `${r.raterWallet.slice(0, 8)}…`} → {r.rating}/5
                            {r.comment && <span className="text-muted-foreground">: &quot;{r.comment.slice(0, 60)}{r.comment.length > 60 ? "…" : ""}&quot;</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {!isConnected && (
              <div className="pt-4 border-t border-border text-center text-muted-foreground">
                Connect your wallet to interact with this escrow
              </div>
            )}
            <TradeTxList escrow={selectedEscrow} local={transactions.filter((t) => t.offerId === selectedEscrow.offerId)} />
              </TabsContent>

              <TabsContent value="chat" className="mt-4">
                <OfferChat escrow={selectedEscrow} profileMap={profileMap} />
              </TabsContent>

              <TabsContent value="dispute" className="mt-4">
                <DisputeView 
                  escrow={selectedEscrow} 
                  onClose={() => setDisputeTab("details")}
                />
              </TabsContent>
            </Tabs>
  ) : null;

  // Open offers from creators who have not been around for a while: faded, at the end of the list
  const inactiveDaysOf = (e: Escrow): number | null => {
    if (e.state !== "CREATED" || e.creator === account?.account) return null;
    const la = profileMap[e.creator]?.lastActive;
    if (!la || profileMap[e.creator]?.isOnline) return null;
    const days = Math.floor((Date.now() - Date.parse(la)) / 86400000);
    return days >= INACTIVE_DAYS ? days : null;
  };
  const marketEscrows = viewMode === "mine" ? displayedEscrows : [
    ...displayedEscrows.filter((e) => inactiveDaysOf(e) === null),
    ...displayedEscrows.filter((e) => inactiveDaysOf(e) !== null),
  ];
  // Your own open offer in its last day on the market: say so, with "Keep listed"
  const expiresInHours = (e: Escrow): number | null => {
    if (e.state !== "CREATED" || e.creator !== account?.account || hiddenIds.has(e.offerId) || !e.listedUntil) return null;
    const left = new Date(e.listedUntil).getTime() - Date.now();
    return left > 0 && left <= 86400000 ? Math.max(1, Math.round(left / 3600000)) : null;
  };
  const offerCard = (e: Escrow) => (
    <OfferCard
      key={e.offerId}
      escrow={e}
      profileMap={profileMap}
      ratingSummaryMap={ratingSummaryMap}
      completedMap={completedMap}
      onSelect={setSelectedOfferId}
      onDelete={handleDeleteOffer}
      isDeletingOfferId={deletingOfferId}
      role={viewMode === "active" || viewMode === "mine" ? (e.seller === account?.account ? "seller" : "buyer") : role}
      isSelected={selectedOfferId === e.offerId}
      hasOpenDispute={openDisputeOfferIds.has(e.offerId)}
      inactiveDays={inactiveDaysOf(e)}
      hiddenReason={e.state === "CREATED" && e.creator === account?.account ? hiddenReasons.get(e.offerId) ?? null : null}
      onRelist={handleRelist}
      unfundedExpired={unfundedExpired(e)}
      expiresInHours={expiresInHours(e)}
      onRepeat={repeatOffer}
    />
  );
  const live = (e: Escrow) => ACTIVE_STATES.includes(e.state as (typeof ACTIVE_STATES)[number]) && !unfundedExpired(e);
  const mineGroups: [string, Escrow[]][] = viewMode === "mine"
    ? [
        // trades waiting for you first, the most urgent at the top
        ["Your turn", displayedEscrows
          .filter((e) => live(e) && !openDisputeOfferIds.has(e.offerId) && turnInfo(e, account?.account)?.mine)
          .sort((a, b) => (turnInfo(a, account?.account)?.remaining ?? 1e9) - (turnInfo(b, account?.account)?.remaining ?? 1e9))],
        ["Waiting for the other side", displayedEscrows.filter((e) => live(e) && (openDisputeOfferIds.has(e.offerId) || !turnInfo(e, account?.account)?.mine))],
        ["Your open offers", displayedEscrows.filter((e) => e.state === "CREATED")],
        ["Finished", displayedEscrows.filter((e) => PAST_TERMINAL_STATES.includes(e.state as (typeof PAST_TERMINAL_STATES)[number]) || unfundedExpired(e))],
      ]
    : [];

  return (
    <div className="space-y-6">
      {/* All Offers List */}
      <Card className={isMobile ? "border-0 bg-transparent shadow-none" : "escrow-card"}>
        {isMobile ? (
          <div className="flex items-center justify-between pb-2">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {isLoading && escrows.length === 0 ? "Loading…" : `${displayedEscrows.length} ${viewMode === "mine" ? (displayedEscrows.length === 1 ? "item" : "items") : displayedEscrows.length === 1 ? "offer" : "offers"}`}
            </p>
            <Button variant="ghost" size="sm" className="h-10 gap-2" onClick={loadAll} disabled={isLoading}>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
        ) : (
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <List className="h-5 w-5 text-primary" />
                {viewMode === "active"
                  ? "Active Trades"
                  : viewMode === "new"
                  ? "New offers - Marketplace"
                  : viewMode === "myPast"
                  ? "All my past offers"
                  : viewMode === "my"
                  ? "My Offers"
                  : role === "buyer"
                    ? "All Sell Offers"
                    : "All Buy Offers"}
              </CardTitle>
              <CardDescription>
                {viewMode === "active"
                  ? "Trades in progress (accepted, funded, paid, disputed)"
                  : viewMode === "new"
                  ? "Only new created offers. Nothing else."
                  : viewMode === "myPast"
                  ? "Trades you took part in that ended as Completed, Refunded, or Closed"
                  : viewMode === "my"
                  ? "Manage all offers you've created"
                  : role === "buyer"
                    ? "Browse available sell offers to accept"
                    : "Browse available buy offers to accept"}
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={loadAll} disabled={isLoading}>
                {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        )}
        <CardContent className={isMobile ? "p-0" : undefined}>
          {isLoading && escrows.length === 0 ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : displayedEscrows.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">
              {escrows.length === 0
                ? (viewMode === "mine"
                    ? "No trades yet. Take an offer in Offers, or post your own in New offer."
                    : viewMode === "active"
                    ? "You have no active trades. Accept an offer as buyer or wait for a buyer as seller to see trades here."
                    : viewMode === "new"
                    ? "No new offers at the moment. Check back later."
                    : viewMode === "myPast"
                    ? "You have no past offers. Past offers are trades you participated in that ended as Completed, Refunded, or Closed."
                    : viewMode === "my"
                    ? "You haven't created any offers yet. Create your first offer in the Create Offer tab."
                    : role === "buyer"
                      ? "No sell offers found. Try adjusting your filters or create a new offer."
                      : "No buy offers found. Try adjusting your filters or create a new offer.")
                : "No offers match your filters (min rating or online now). Try clearing filters."}
            </p>
          ) : (
            viewMode === "mine" ? (
              <div className="space-y-6">
                {mineGroups.filter(([, list]) => list.length > 0).map(([title, list]) => (
                  <section key={title} className="space-y-3">
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">{list.map(offerCard)}</div>
                  </section>
                ))}
              </div>
            ) : (
            <div className={isMobile ? "grid grid-cols-1 gap-3" : "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"}>
              {marketEscrows.map(offerCard)}
            </div>
            )
          )}
        </CardContent>
      </Card>

      {/* Escrow Details (when one is selected) */}
      {selectedEscrow && isMobile && createPortal(
        <div className="fixed inset-0 z-[60] flex flex-col bg-background" role="dialog" aria-modal="true" aria-label={tradeTitle(selectedEscrow, account?.account)}>
          <header className="flex items-center gap-1 border-b border-border bg-card px-2 py-2">
            <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" onClick={closeTrade} aria-label="Back to the list">
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-display text-lg font-semibold leading-tight">{tradeTitle(selectedEscrow, account?.account)}</h2>
              <TradeCode offerId={selectedEscrow.offerId} copy className="mt-0.5" />
              {isV11(selectedEscrow) && <span className="ml-2 text-xs text-muted-foreground">{chainLabel(selectedEscrow.trade.chain)}</span>}
            </div>
            {isV11(selectedEscrow) && <ShareButton item={tradeShareItem(selectedEscrow.trade)} iconOnly variant="ghost" className="h-11 w-11" />}
            <span className="shrink-0 pr-2"><EscrowStatus state={shownState(selectedEscrow)} /></span>
          </header>
          <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4">
            <YourTurnCard escrow={selectedEscrow} me={account?.account} canAccept={canAcceptFinal} />
            {canAcceptFinal && acceptLimit && (
              <p role="note" className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-3 text-sm">{acceptLimit}</p>
            )}
            <TradeSteps escrow={selectedEscrow} me={account?.account} />
            {detailTabs}
          </div>
          {mobilePrimary && (
            <div className="border-t border-border bg-card px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Button className="h-14 w-full gap-2 text-lg" onClick={mobilePrimary.run} disabled={!!actionLoading}>
                {actionLoading === mobilePrimary.busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <mobilePrimary.Icon className="h-5 w-5" />}
                {mobilePrimary.label}
              </Button>
              <p className="mt-1.5 text-center text-xs text-muted-foreground">
                {actionLoading ? "Confirming on Kadena. This can take up to 2 minutes." : "You'll approve this in your wallet."}
              </p>
            </div>
          )}
        </div>,
        document.body,
      )}

      {selectedEscrow && !isMobile && (
        <Card className="escrow-card">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-3 text-lg"><TradeCode offerId={selectedEscrow.offerId} copy size="md" /><span className="font-mono text-sm font-normal text-muted-foreground">{selectedEscrow.offerId}</span>{isV11(selectedEscrow) && <span className="text-xs font-normal text-muted-foreground">{chainLabel(selectedEscrow.trade.chain)}</span>}{isV11(selectedEscrow) && <ShareButton item={tradeShareItem(selectedEscrow.trade)} variant="ghost" className="h-9 px-2" />}</CardTitle>
              <EscrowStatus
                state={
                  existingDispute && (existingDispute.status === "OPEN" || existingDispute.status === "UNDER_REVIEW")
                    ? "DISPUTED"
                    : selectedEscrow.state
                }
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {detailTabs}
          </CardContent>
        </Card>
      )}

      {selectedEscrow && (
        <>
          <MarkPaidDialog escrow={selectedEscrow} total={tradeTotal(selectedEscrow)} open={markPaidOpen} onOpenChange={setMarkPaidOpen} onConfirm={doMarkPaid} />
          <ReleaseDialog escrow={selectedEscrow} total={tradeTotal(selectedEscrow)} open={releaseOpen} onOpenChange={setReleaseOpen} onConfirm={() => { void doRelease(); }} />
          <ConfirmDialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }} title={confirm?.title ?? ""} body={confirm?.body ?? ""} confirmLabel={confirm?.confirmLabel ?? "Confirm"} destructive onConfirm={() => confirm?.run()} warning={confirm?.warning} ack={confirm?.ack} />
          {v11 && (
            <Dialog open={disputeOpen} onOpenChange={setDisputeOpen}>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 font-display text-xl"><AlertTriangle className="h-5 w-5 text-amber-500" />Open a dispute</DialogTitle>
                  <DialogDescription>The trade freezes and the arbiter decides where the {kdaAmount(selectedEscrow.amount)} KDA goes: to the buyer, back to the seller, or split. Say what went wrong; you can add evidence in the Dispute tab after.</DialogDescription>
                </DialogHeader>
                <Textarea value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} rows={4} maxLength={1000} placeholder="What happened?" className="resize-none" />
                <DialogFooter className="flex-col gap-2 sm:flex-col">
                  <Button className="h-12 w-full gap-2" variant="destructive" disabled={!disputeReason.trim()} onClick={() => { void handleV11Dispute(); }}><AlertTriangle className="h-4 w-4" />Open dispute</Button>
                  <Button variant="outline" className="h-11 w-full" onClick={() => setDisputeOpen(false)}>Not now</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </>
      )}

      <TradeEmailGate open={emailGateOpen} onOpenChange={setEmailGateOpen} />
      {terms.gate}

      {/* Rate trade dialog (only for completed trades) */}
      {counterpartyWallet && selectedEscrow && (
        <RatingSubmitDialog
          open={showRatingDialog}
          onOpenChange={setShowRatingDialog}
          offerId={selectedEscrow.offerId}
          ratedWallet={counterpartyWallet}
          onSuccess={() => {
            refetchRatingCheck();
            queryClient.invalidateQueries({ queryKey: ["ratings-summary-bulk"] });
            queryClient.invalidateQueries({ queryKey: ["trade-ratings", selectedEscrow?.offerId] });
            loadAll();
          }}
        />
      )}

    </div>
  );
}
