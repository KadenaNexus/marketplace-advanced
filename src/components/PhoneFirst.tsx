import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Smartphone } from "lucide-react";
import { AppLogo } from "@/components/AppLogo";
import { useLang } from "@/components/NexusLanding";
import { LINX_ANDROID, LINX_IOS, LinxPath, inWalletBrowser, linxStoreLink } from "@/components/OpenInLinx";
import { SharedPreview } from "@/components/Share";
import { refFromLink } from "@/lib/share";

const COPY = {
  en: {
    title: "The Marketplace is in Linx Wallet",
    lead: "Kadena P2P Marketplace runs inside the Linx Wallet app on your phone. Every trade step is approved right there, without switching apps.",
    step1: "Install Linx Wallet",
    step2: "In Linx, open",
    step2b: "Your offers, trades and chats are all there.",
    open: "Open Linx Wallet",
    iphone: "iPhone",
    android: "Android",
    scan: "Scan with your phone's camera to get Linx",
    already: "Opened this from Linx and still see this page? Continue",
    stay: "Arbiter sign-in",
  },
  ar: {
    title: "السوق داخل محفظة Linx",
    lead: "سوق Kadena P2P يعمل من داخل تطبيق محفظة Linx على جوالك. توافق على كل خطوة في الصفقة هناك دون التنقل بين التطبيقات.",
    step1: "ثبّت محفظة Linx",
    step2: "في Linx افتح",
    step2b: "عروضك وصفقاتك ومحادثاتك كلها هناك.",
    open: "افتح محفظة Linx",
    iphone: "iPhone",
    android: "Android",
    scan: "امسح بكاميرا جوالك لتحميل Linx",
    already: "فتحت الصفحة من Linx وما زالت تظهر؟ تابع",
    stay: "دخول المحكّم",
  },
} as const;

/** A computer: a fine pointer (mouse) and a wide screen. Touch screens (phones, tablets) are not. */
function isComputer(): boolean {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return !coarse && window.innerWidth >= 768;
}

/**
 * Fallback if Linx's browser is ever not recognised: "?inlinx=1" in the address (or the small link on the
 * screen) lets this visit through, so a real Linx user is never locked out. It lasts only for this tab
 * (sessionStorage): a phone browser that once used it gets the Linx screen again on its next visit.
 * Earlier versions kept it forever in localStorage; that old flag is removed here.
 */
const PASS_KEY = "nx-in-wallet";
function passed(): boolean {
  try { localStorage.removeItem(PASS_KEY); } catch { /* ignore */ }
  try {
    if (new URLSearchParams(window.location.search).get("inlinx") === "1") { sessionStorage.setItem(PASS_KEY, "1"); return true; }
    return sessionStorage.getItem(PASS_KEY) === "1";
  } catch { return false; }
}

/**
 * The Marketplace is used only inside Linx Wallet (Explore > Web3 Apps > Kadena > Kadena P2P Marketplace).
 * Anywhere else (a phone's browser, a computer) shows how to get there instead. The arbiter's dispute board
 * (/admin) is a separate route and is not affected.
 */
export function PhoneFirst({ children }: { children: ReactNode }) {
  const [where] = useState<"ok" | "computer" | "browser">(() =>
    isComputer() ? "computer" : inWalletBrowser() || passed() ? "ok" : "browser");
  const [through, setThrough] = useState(false);
  if (where === "ok" || through) return <>{children}</>;
  return <LinxOnlyScreen computer={where === "computer"} onContinue={() => { try { sessionStorage.setItem(PASS_KEY, "1"); } catch { /* ignore */ } setThrough(true); }} />;
}

function Qr({ url, label }: { url: string; label: string }) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    import("qrcode")
      .then((QRCode) => QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: "M", color: { dark: "#123A48", light: "#FFFFFF" } }))
      .then(setQr).catch(() => setQr(null));
  }, [url]);
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="flex flex-col items-center gap-2">
      <span className="flex h-44 w-44 items-center justify-center rounded-2xl border border-border bg-white p-3 shadow-sm">
        {qr ? <img src={qr} alt={label} className="h-full w-full" /> : <Smartphone className="h-8 w-8 text-muted-foreground" />}
      </span>
      <span className="text-sm font-semibold">{label}</span>
    </a>
  );
}

function LinxOnlyScreen({ computer, onContinue }: { computer: boolean; onContinue: () => void }) {
  const [lang] = useLang();
  const t = COPY[lang];
  const stepNo = "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground";
  // a share link someone tapped (/s/… redirects to ?offer=…): show what it is and how to open it in Linx
  const [shared] = useState(() => { try { return refFromLink(new URLSearchParams(window.location.search).get("offer") ?? ""); } catch { return null; } });
  return (
    <div className="min-h-screen bg-background" dir={lang === "ar" ? "rtl" : "ltr"} lang={lang}>
      <header className="border-b border-border bg-card/50" dir="ltr">
        <div className="container mx-auto px-4 py-4"><AppLogo /></div>
      </header>
      <main className="container mx-auto max-w-3xl space-y-8 px-4 py-10">
        {shared && <SharedPreview refId={shared} />}
        <div className="space-y-3">
          <h1 className="font-display text-3xl font-bold leading-tight md:text-4xl">{t.title}</h1>
          <p className="text-lg text-muted-foreground">{t.lead}</p>
        </div>
        <ol className="space-y-6">
          <li className="flex gap-4">
            <span className={stepNo}>1</span>
            <div className="min-w-0 flex-1 space-y-3">
              <p className="pt-1 font-semibold">{t.step1}</p>
              {computer ? (
                <>
                  <div className="flex flex-wrap gap-6">
                    <Qr url={LINX_IOS} label={t.iphone} />
                    <Qr url={LINX_ANDROID} label={t.android} />
                  </div>
                  <p className="text-sm text-muted-foreground">{t.scan}</p>
                </>
              ) : (
                <a href={linxStoreLink()} target="_blank" rel="noopener noreferrer"
                  className="inline-flex h-12 items-center gap-2 rounded-full bg-primary px-6 font-semibold text-primary-foreground hover:opacity-90">
                  {t.open}<ExternalLink className="h-4 w-4" />
                </a>
              )}
            </div>
          </li>
          <li className="flex gap-4">
            <span className={stepNo}>2</span>
            <div className="min-w-0 flex-1 space-y-2">
              <p className="pt-1 font-semibold">{t.step2}</p>
              <LinxPath lang={lang} className="text-sm" />
              <p className="text-sm text-muted-foreground">{t.step2b}</p>
            </div>
          </li>
        </ol>
        {!computer && (
          <button type="button" onClick={onContinue} className="text-xs text-muted-foreground underline hover:text-foreground">{t.already}</button>
        )}
      </main>
      <footer className="container mx-auto px-4 pb-10 text-center">
        {computer && <Link to="/admin" className="text-xs text-muted-foreground underline hover:text-foreground">{t.stay}</Link>}
      </footer>
    </div>
  );
}
