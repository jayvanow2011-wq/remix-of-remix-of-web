import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { useSubscription, formatCountdown } from "@/lib/use-subscription";
import { createNowPayment } from "@/lib/payments.functions";
import { CreditCard, Clock, Check, Loader2, Sparkles, ArrowUp, Sun } from "lucide-react";

export const Route = createFileRoute("/dashboard/subs")({
  component: SubsPage,
});

const BONUS = 1.2; // summer sale multiplier

const PLANS: { id: string; label: string; usd: number; days: number; popular?: boolean; best?: boolean }[] = [
  { id: "1week", label: "1 Week", usd: 5, days: 7 },
  { id: "1month", label: "1 Month", usd: 15, days: 30, popular: true },
  { id: "3months", label: "3 Months", usd: 35, days: 90 },
  { id: "6months", label: "6 Months", usd: 60, days: 180 },
  { id: "1year", label: "1 Year", usd: 100, days: 365, best: true },
  { id: "lifetime", label: "Lifetime", usd: 200, days: 36500 },
];

function SubsPage() {
  const { user } = useAuth();
  const sub = useSubscription(user?.id);
  const [buying, setBuying] = useState<string | null>(null);
  const [payEnabled, setPayEnabled] = useState(true);
  const [payMode, setPayMode] = useState<"live" | "sandbox">("live");
  const pay = useServerFn(createNowPayment);

  useEffect(() => {
    supabase
      .from("app_settings")
      .select("value")
      .eq("key", "payments")
      .maybeSingle()
      .then(({ data }) => {
        const v = (data?.value ?? {}) as { enabled?: boolean; mode?: "live" | "sandbox" };
        setPayEnabled(v.enabled !== false);
        setPayMode(v.mode === "sandbox" ? "sandbox" : "live");
      });
  }, []);

  const purchase = async (planId: string) => {
    if (!user) return;
    if (!payEnabled) {
      toast.error("Payments are temporarily disabled. Please check back soon.");
      return;
    }
    setBuying(planId);
    try {
      const result = await pay({ data: { planId, userId: user.id } });
      if ((result as any).test) {
        toast.success("Test purchase activated — subscription extended.");
      } else if (result.invoiceUrl) {
        await supabase.from("subscriptions").insert({
          user_id: user.id,
          plan: planId,
          status: "pending",
          provider_payment_id: result.invoiceId,
          amount_usd: PLANS.find((p) => p.id === planId)?.usd ?? 0,
          currency: "BTC",
        });
        window.open(result.invoiceUrl, "_blank");
      }
    } catch (err: any) {
      toast.error(err?.message ?? "Payment failed");
    }
    setBuying(null);
  };

  const low = sub.active && isFinite(sub.msLeft) && sub.msLeft < 1000 * 60 * 60 * 24 * 3;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Subscriptions</h1>
          {payMode === "sandbox" && (
            <span className="rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-yellow-500">
              Test mode
            </span>
          )}
          {!payEnabled && (
            <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-destructive">
              Disabled
            </span>
          )}
        </div>
        {!payEnabled && (
          <p className="mt-1 text-sm text-muted-foreground">Payments are temporarily disabled.</p>
        )}
      </div>

      {/* Summer sale banner */}
      <div className="relative overflow-hidden rounded-xl border border-border bg-card p-5">
        <div className="absolute inset-0 -z-10 opacity-30"
          style={{ background: "radial-gradient(600px circle at 0% 0%, oklch(0.7 0.18 60 / 0.35), transparent 60%), radial-gradient(500px circle at 100% 100%, oklch(0.65 0.2 25 / 0.3), transparent 55%)" }} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-background">
              <Sun className="h-5 w-5 text-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                Summer Sale
                <span className="rounded-full border border-foreground/30 bg-foreground/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                  Limited
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                Every subscription you buy is <span className="font-mono text-foreground">×{BONUS}</span> longer. Auto-applied at checkout.
              </div>
            </div>
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            <span className="text-foreground">+{Math.round((BONUS - 1) * 100)}%</span> bonus days
          </div>
        </div>
      </div>

      {/* Status card */}
      {sub.loading ? (
        <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">Loading…</div>
      ) : sub.active ? (
        <div className={`rounded-xl border bg-card p-5 ${low ? "border-destructive/60" : "border-border"}`}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Check className={`h-4 w-4 ${low ? "text-destructive" : "text-foreground"}`} />
                <span className="text-base font-semibold capitalize">
                  {sub.isAdmin ? "Admin access" : (sub.plan ?? "active").replace("_", " ")}
                </span>
              </div>
              {sub.expiresAt && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Expires {sub.expiresAt.toLocaleString()}
                </p>
              )}
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1 justify-end">
                <Clock className="h-3 w-3" /> Remaining
              </p>
              <p className={`font-mono text-xl font-bold ${low ? "text-destructive" : "text-foreground"}`}>
                {formatCountdown(sub.msLeft)}
              </p>
            </div>
          </div>
          {low && (
            <p className="mt-3 text-xs text-destructive">
              Your subscription is about to expire — renew below to keep access.
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-destructive/40 bg-card p-5">
          <p className="text-sm font-medium text-destructive">No active subscription.</p>
        </div>
      )}

      {/* Plans */}
      <div>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          {sub.active ? <><ArrowUp className="h-4 w-4" /> Extend or upgrade</> : <><Sparkles className="h-4 w-4" /> Choose a plan</>}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {PLANS.map((plan) => {
            const bonusDays = Math.round(plan.days * (BONUS - 1));
            return (
              <button
                key={plan.id}
                onClick={() => purchase(plan.id)}
                disabled={buying !== null}
                className={`group relative flex flex-col items-start gap-1.5 rounded-xl border bg-card p-4 text-left transition hover:-translate-y-0.5 hover:border-foreground/40 disabled:opacity-50 ${
                  plan.best ? "border-foreground/40" : "border-border"
                }`}
              >
                {plan.popular && <span className="absolute right-3 top-3 rounded-full border border-foreground/30 bg-foreground/10 px-1.5 py-0.5 text-[9px] font-bold uppercase">Popular</span>}
                {plan.best && <span className="absolute right-3 top-3 rounded-full bg-foreground px-1.5 py-0.5 text-[9px] font-bold uppercase text-background">Best</span>}
                <span className="text-xs text-muted-foreground">{plan.label}</span>
                <span className="text-2xl font-bold tracking-tight">${plan.usd}</span>
                {plan.id !== "lifetime" && bonusDays > 0 && (
                  <span className="rounded-full border border-foreground/20 px-1.5 py-0.5 text-[10px] font-mono text-foreground/80">
                    +{bonusDays}d summer bonus
                  </span>
                )}
                <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">BTC · XMR · LTC</span>
                {buying === plan.id && <Loader2 className="absolute right-3 bottom-3 h-4 w-4 spin-soft" />}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Tip: visit the <a href="/dashboard/refer" className="text-foreground hover:underline">refer page</a> to earn free days.
        </p>
      </div>
    </div>
  );
}
