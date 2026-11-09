import { useNavigate, Link, useLocation, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { WalletConnect } from "@/components/WalletConnect";
import { AppLogo } from "@/components/AppLogo";
import NexusLanding, { useLang } from "@/components/NexusLanding";
import { OfferAlertsButton, useAlertsStatus } from "@/components/OfferAlerts";
import { ALERTS_COPY } from "@/lib/alertsCopy";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import { fetchProfile } from "@/lib/profileApi";
import { NETWORK_ID, PLATFORM_ARBITER, readEscrow } from "@/lib/kadena";
import { V11_CHAINS, canonicalRef, parseRef, readPool, readTrade } from "@/lib/v11";
import { useV11Config } from "@/hooks/useV11";
import { LogOut, Shield, Megaphone, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NotificationBell } from "@/components/NotificationBell";
import { toast } from "sonner";
import type { MobileTab } from "@/components/MobileMarket";
import { REPEAT_OFFER_EVENT, type OfferDraft } from "@/lib/repeatOffer";
import { useIsMobile } from "@/hooks/use-mobile";

// The signed-in market loads on demand, so first-time visitors only download the landing page.
const RoleSelection = lazy(() => import("@/components/RoleSelection").then((m) => ({ default: m.RoleSelection })));
const EscrowActions = lazy(() => import("@/components/EscrowActions").then((m) => ({ default: m.EscrowActions })));
const BuyerView = lazy(() => import("@/components/BuyerView").then((m) => ({ default: m.BuyerView })));
const SellerView = lazy(() => import("@/components/SellerView").then((m) => ({ default: m.SellerView })));
const MobileMarket = lazy(() => import("@/components/MobileMarket").then((m) => ({ default: m.MobileMarket })));

const Loading = () => (
  <div className="flex justify-center py-16 text-sm text-muted-foreground" role="status">
    Loading…
  </div>
);

type UserRole = "buyer" | "seller" | null;

const Index = () => {
  const { account, isConnected } = useWallet();
  const [role, setRole] = useState<UserRole>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useState<MobileTab>("offers");

  const { data: profile } = useQuery({
    queryKey: ["profile", account?.account],
    queryFn: () => fetchProfile(account!.account),
    enabled: !!account && isConnected,
  });

  const { data: v11Config } = useV11Config();
  const isArbiter = !!account && (account.account === PLATFORM_ARBITER || account.account === v11Config?.arbiter);

  // Offer alerts: sign-up strip, and links from alert emails (?offer=ID)
  const [lang] = useLang();
  const alerts = useAlertsStatus();
  const [params] = useSearchParams();
  // a v11 link names (chain, id): "?offer=2:trade-…" (chain 2); no chain = chain 1, so older links keep working
  const linkedRaw = params.get("offer") ?? params.get("pool");
  const linkedOffer = linkedRaw ? canonicalRef(linkedRaw) : null;
  // Links to an offer or trade (?offer=ID) from alert emails and notifications: an open offer opens on the
  // side that can accept it; a trade you are part of opens in Active Trades on the home view.
  const linkHandled = useRef<string | null>(null);
  const location = useLocation();
  useEffect(() => {
    // keyed on the navigation, so the same trade can be opened again from a later notification
    if (!linkedOffer || !isConnected || !account || linkHandled.current === location.key) return;
    linkHandled.current = location.key;
    const me = account.account;
    // v11 first: a trade I am part of opens in My trades; a pool opens in the market on the side that can take it
    const rawId = parseRef(linkedOffer).id;
    const v11 = rawId.startsWith("trade-")
      ? readTrade(linkedOffer).then((t) => (t ? { trade: t } : null))
      : rawId.startsWith("pool-")
        ? readPool(linkedOffer).then((p) => (p ? { pool: p } : null))
        : Promise.resolve(null);
    v11.then((r) => {
      if (r && "trade" in r) {
        if (r.trade.seller === me || r.trade.buyer === me) { setRole(null); setMobileTab("trades"); }
        else toast.info(ALERTS_COPY[lang].offerGone);
        return;
      }
      if (r && "pool" in r) {
        if (r.pool.creator === me) { setRole(null); setMobileTab("trades"); }
        else { setRole(r.pool.side === "SELL" ? "buyer" : "seller"); setMobileTab("offers"); }
        return;
      }
      if (parseRef(linkedOffer).chain !== "1") return toast.info(ALERTS_COPY[lang].offerGone); // v10 is on chain 1 only
      return readEscrow(linkedOffer).then((e) => {
        if (!e) return toast.info(ALERTS_COPY[lang].offerGone);
        if (e.state === "CREATED" && e.creator !== me) { setRole(e.side === "SELL" ? "buyer" : "seller"); setMobileTab("offers"); }
        else if (e.creator === me || e.buyer === me || e.seller === me) { setRole(null); setMobileTab("trades"); }
        else toast.info(ALERTS_COPY[lang].offerGone);
      });
    }).catch(() => {});
  }, [linkedOffer, isConnected, account, lang, location.key]);

  // "Post again" on a finished offer: open New offer on the same side (the form fills itself in)
  useEffect(() => {
    const go = (ev: Event) => {
      const d = (ev as CustomEvent<OfferDraft>).detail;
      setRole(d.side === "SELL" ? "seller" : "buyer");
      setMobileTab("new");
      window.scrollTo({ top: 0 });
    };
    window.addEventListener(REPEAT_OFFER_EVENT, go);
    return () => window.removeEventListener(REPEAT_OFFER_EVENT, go);
  }, []);

  // Back from a trade email link: confirmed, turned off, or an old link
  const navigate = useNavigate();
  const tradeEmail = params.get("trade-email");
  useEffect(() => {
    if (!tradeEmail) return;
    if (tradeEmail === "on") toast.success("Email confirmed", { description: "You can trade now. Every step of your trades comes by email too." });
    else toast.error("This email link has expired or was already used", { description: "Ask for a new one from the bell." });
    navigate("/", { replace: true });
  }, [tradeEmail, navigate]);

  const handleRoleSelect = (selectedRole: UserRole) => {
    setRole(selectedRole);
  };

  const handleRoleChange = () => {
    setRole(null);
  };

  const handleOfferCreated = () => {
    setRefreshTrigger((r) => r + 1);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto flex items-center justify-between gap-3 px-4 py-3 sm:flex-wrap sm:gap-y-3 sm:py-4">
          <AppLogo />
          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-4">
            <span className="hidden rounded-full border border-border bg-secondary px-3 py-1 text-xs font-medium text-muted-foreground sm:inline-flex">
              {NETWORK_ID === "mainnet01" ? "Mainnet" : NETWORK_ID} · Chain{V11_CHAINS.length > 1 ? "s" : ""} {V11_CHAINS.join(" & ")}
            </span>
            <span className="hidden sm:inline-flex"><ThemeToggle /></span>
            <NotificationBell />
            {isArbiter && (
              <Link to="/admin" title="Admin / Arbiter panel">
                <Button variant="outline" size="sm" className="gap-1.5 px-2 sm:px-3" aria-label="Admin">
                  <Shield className="h-4 w-4" />
                  <span className="hidden sm:inline">Admin</span>
                </Button>
              </Link>
            )}
            {isConnected && account && (
              <Link
                to={`/u/${encodeURIComponent(account.account)}`}
                className="hidden transition-opacity hover:opacity-80 md:block"
                title="View profile"
              >
                <Avatar className="h-8 w-8">
                  <AvatarImage src={profile?.avatar || "/default-avatar.svg"} alt="" />
                  <AvatarFallback className="text-xs bg-muted">
                    {profile?.username?.slice(0, 2).toUpperCase() || account.account.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </Link>
            )}
            <WalletConnect inHeader />
          </div>
        </div>
      </header>

      <main className={isConnected ? (isMobile ? "container mx-auto px-4 py-4" : "container mx-auto px-4 py-8") : "w-full"}>
        {!isConnected ? (
          <NexusLanding walletAction={<WalletConnect />} fromAlert={!!linkedOffer} />
        ) : (
          <Suspense fallback={<Loading />}>
          {isMobile ? (
          <MobileMarket
            tab={mobileTab}
            onTab={setMobileTab}
            side={role ?? "buyer"}
            onSide={setRole}
            refreshTrigger={refreshTrigger}
            lang={lang}
            alertsEnabled={!!alerts.data?.enabled}
            avatar={profile?.avatar}
          />
        ) : (
          <>
            {/* Top announcement — visible after sign-in (orange theme) */}
            <Card className="mb-8 border-orange-500/40 bg-gradient-to-r from-orange-600 via-orange-500 to-orange-400 dark:from-orange-700 dark:via-orange-600 dark:to-orange-500">
              <CardContent className="flex flex-col sm:flex-row gap-3 sm:items-start pt-6">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/20">
                  <Megaphone className="h-5 w-5 text-white" />
                </div>
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold text-white">New: take any amount from an offer</h2>
                  <p className="text-sm text-white/95 leading-relaxed">
                    Offers are pools with a min and max per trade. Sellers lock the KDA when posting, so a buyer's take is funded at once: no accept step, no waiting for a deposit. Kadena tokens settle instantly.
                  </p>
                </div>
              </CardContent>
            </Card>

            {alerts.data?.enabled && (
              <div className="mb-8 flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between" dir={lang === "ar" ? "rtl" : "ltr"}>
                <p className="flex items-center gap-2 text-sm">
                  <Bell className="h-4 w-4 shrink-0 text-primary" />
                  {ALERTS_COPY[lang].strip}
                </p>
                <OfferAlertsButton lang={lang} className="shrink-0" />
              </div>
            )}

            {!role ? (
              <div className="space-y-10">
                {/* My active trades: seller or buyer, state in progress */}
                <section>
                  <EscrowActions refreshTrigger={refreshTrigger} viewMode="active" role="seller" />
                </section>
                <RoleSelection onSelectRole={handleRoleSelect} />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-end">
                  <Button variant="outline" size="sm" onClick={handleRoleChange} className="gap-2">
                    <LogOut className="h-4 w-4" />
                    Change Role
                  </Button>
                </div>
                {role === "buyer" ? (
                  <BuyerView refreshTrigger={refreshTrigger} />
                ) : (
                  <SellerView refreshTrigger={refreshTrigger} />
                )}
              </div>
            )}
          </>
          )}
          </Suspense>
        )}
      </main>

      {/* Footer */}
      <footer className={`mt-16 border-t border-border py-6 ${isConnected && isMobile ? "hidden" : ""}`}>
        <div className="container mx-auto flex flex-col items-center gap-3 px-4 text-center text-sm text-muted-foreground">
          <p>Built on Kadena • Powered by Pact Smart Contracts</p>
          <nav aria-label="Kadena Nexus links" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <a className="transition-colors hover:text-foreground" href="https://kadena.ws/">
              Part of Kadena Nexus
            </a>
            <span aria-hidden="true">·</span>
            <a className="transition-colors hover:text-foreground" href="https://github.com/KadenaNexus">
              Kadena Nexus on GitHub
            </a>
            <span aria-hidden="true">·</span>
            <a className="transition-colors hover:text-foreground" href="https://nodes.kadena.ws/">
              Network Monitor
            </a>
            <span aria-hidden="true">·</span>
            <a className="transition-colors hover:text-foreground" href="https://adoption.kadena.ws/">
              Adoption Index
            </a>
            <span aria-hidden="true">·</span>
            <a className="transition-colors hover:text-foreground" href="https://buy.kadena.ws/">
              Kadeway
            </a>
            <span aria-hidden="true">·</span>
            <Link className="transition-colors hover:text-foreground" to="/terms">
              Terms and risks
            </Link>
            <span aria-hidden="true">·</span>
            <a className="transition-colors hover:text-foreground" href="https://earn.kadena.ws/">
              Kadena Earn
            </a>
            <span aria-hidden="true">·</span>
            <a className="transition-colors hover:text-foreground" href="https://quantum.kadena.ws/">
              Quantum-Safe Kadena
            </a>
            <span aria-hidden="true">·</span>
            <a className="transition-colors hover:text-foreground" href="https://kadena.ws/whales/">
              Whale Watch
            </a>
            <span aria-hidden="true">·</span>
            <a className="transition-colors hover:text-foreground" href="https://kadenadevs.kadena.ws/">
              Kadena Devs
            </a>
            <span aria-hidden="true">·</span>
            <a className="transition-colors hover:text-foreground" href="https://kadena.ws/community-edition/">
              Kadena Community Edition
            </a>
            <span aria-hidden="true">·</span>
            <a className="transition-colors hover:text-foreground" href="https://kadena.ws/buy-kda/">
              How to buy KDA
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
};

export default Index;
