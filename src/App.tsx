import { TxProgressOverlay } from "@/components/TxProgressOverlay";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from "react-router-dom";
import { WalletProvider } from "@/hooks/useWallet";
import { ThemeProvider } from "next-themes";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useNewMessageNotification } from "@/hooks/useNewMessageNotification";
import { useTradeDeadlineReminders } from "@/hooks/useTradeDeadlineReminders";
import { NotificationsProvider, useNotifications } from "@/hooks/useNotifications";
import { PhoneFirst } from "@/components/PhoneFirst";
import { PreviewBanner } from "@/components/PreviewBanner";
import { ShareHost } from "@/components/Share";
import { refFromLink } from "@/lib/share";
import { lazy, Suspense } from "react";
import Index from "./pages/Index";

// Pages other than the landing page load on demand to keep the first download small.
const NotFound = lazy(() => import("./pages/NotFound"));
const Profile = lazy(() => import("./pages/Profile"));
const Admin = lazy(() => import("./pages/Admin"));
const AdminDisputeDetail = lazy(() => import("./pages/AdminDisputeDetail"));
const Alerts = lazy(() => import("./pages/Alerts"));
const WalletCheck = lazy(() => import("./pages/WalletCheck"));
const Terms = lazy(() => import("./pages/Terms"));

const queryClient = new QueryClient();

/**
 * /s/<ref>, a share link. The server normally answers it (a page with a preview card for Telegram, WhatsApp, X);
 * where it doesn't, this sends the visitor to the pool or trade the same way. Other parameters (?inlinx=1) are kept.
 */
function ShareRedirect() {
  const { ref = "" } = useParams();
  const { search } = useLocation();
  const r = refFromLink(ref);
  const q = new URLSearchParams(search);
  if (r) q.set("offer", r);
  const qs = q.toString();
  return <Navigate to={`/${qs ? `?${qs}` : ""}`} replace />;
}

// Component to initialize WebSocket connection and new-message notifications
function OnlineStatusProvider({ children }: { children: React.ReactNode }) {
  useOnlineStatus(); // Initialize WebSocket connection
  useNewMessageNotification(); // Toast + invalidate when user receives a message
  return <>{children}</>;
}

// The server sends deadline reminders when its notification feed is on; otherwise the browser does it here.
function DeadlineFallback() {
  const { feed } = useNotifications();
  useTradeDeadlineReminders(feed === "off");
  return null;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} storageKey="kadena-nexus-theme">
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <TxProgressOverlay />
        <PreviewBanner />
        <BrowserRouter>
          <WalletProvider>
            <ShareHost />
            <OnlineStatusProvider>
              <NotificationsProvider>
              <DeadlineFallback />
              <Suspense fallback={null}>
              <Routes>
                <Route path="/" element={<PhoneFirst><Index /></PhoneFirst>} />
                <Route path="/s/:ref" element={<ShareRedirect />} />
                <Route path="/u/:wallet" element={<Profile />} />
                <Route path="/admin" element={<Admin />} />
                <Route path="/alerts" element={<Alerts />} />
                <Route path="/wallet-check" element={<WalletCheck />} />
                <Route path="/terms" element={<Terms />} />
                <Route path="/admin/disputes/:offerId" element={<AdminDisputeDetail />} />
                {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                <Route path="*" element={<NotFound />} />
              </Routes>
              </Suspense>
              </NotificationsProvider>
            </OnlineStatusProvider>
          </WalletProvider>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
