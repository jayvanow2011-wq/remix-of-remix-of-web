import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const PLANS: Record<string, { label: string; usd: number; days: number }> = {
  "1week": { label: "1 Week", usd: 5, days: 7 },
  "1month": { label: "1 Month", usd: 15, days: 30 },
  "3months": { label: "3 Months", usd: 35, days: 90 },
  "6months": { label: "6 Months", usd: 60, days: 180 },
  "1year": { label: "1 Year", usd: 100, days: 365 },
  "lifetime": { label: "Lifetime", usd: 200, days: 36500 },
};

export const createNowPayment = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      planId: z.string().min(1).max(20),
      userId: z.string().uuid(),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const plan = PLANS[data.planId];
    if (!plan) throw new Error("Invalid plan");

    // Read admin-controlled settings
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: settingsRow } = await supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", "payments")
      .maybeSingle();
    const settings = (settingsRow?.value ?? {}) as { enabled?: boolean; mode?: "live" | "sandbox" };
    if (settings.enabled === false) throw new Error("Payments are currently disabled");
    const mode = settings.mode === "sandbox" ? "sandbox" : "live";

    // TEST MODE: simulate a successful payment, no provider call.
    // Activates the subscription immediately with the +20% summer bonus.
    if (mode === "sandbox") {
      const BONUS = 1.2;
      const days = Math.round(plan.days * BONUS);
      const now = new Date();

      // Extend from existing active expiry if later than now
      const { data: existing } = await supabaseAdmin
        .from("subscriptions")
        .select("expires_at")
        .eq("user_id", data.userId)
        .eq("status", "active")
        .order("expires_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const base =
        existing?.expires_at && new Date(existing.expires_at) > now
          ? new Date(existing.expires_at)
          : now;
      const expires = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

      await supabaseAdmin.from("subscriptions").insert({
        user_id: data.userId,
        plan: data.planId,
        status: "active",
        started_at: now.toISOString(),
        expires_at: expires.toISOString(),
        provider: "test",
        provider_payment_id: `test_${Date.now()}`,
        amount_usd: 0,
        currency: "TEST",
      });

      return { invoiceUrl: "", invoiceId: "test", mode, test: true as const };
    }

    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    if (!apiKey) throw new Error("Payment provider not configured");

    const apiBase = "https://api.nowpayments.io";

    const { getRequestHost } = await import("@tanstack/react-start/server");
    let origin = "";
    try {
      const host = getRequestHost();
      origin = host ? `https://${host}` : "";
    } catch {
      origin = "";
    }

    const orderId = `${data.userId}__${data.planId}__${mode}__${Date.now()}`;
    const res = await fetch(`${apiBase}/v1/invoice`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        price_amount: plan.usd,
        price_currency: "usd",
        order_id: orderId,
        order_description: `Veltrix ${plan.label} subscription`,
        ipn_callback_url: origin ? `${origin}/api/public/nowpayments/webhook` : undefined,
        success_url: origin ? `${origin}/dashboard/subs?paid=1` : undefined,
        cancel_url: origin ? `${origin}/dashboard/subs?cancel=1` : undefined,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("NowPayments error", text);
      throw new Error("Payment creation failed");
    }

    const invoice = (await res.json()) as { id: string; invoice_url: string };
    return { invoiceUrl: invoice.invoice_url, invoiceId: String(invoice.id), mode };
  });
