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

    const apiKey =
      mode === "sandbox"
        ? process.env.NOWPAYMENTS_API_KEY_SANDBOX || process.env.NOWPAYMENTS_API_KEY
        : process.env.NOWPAYMENTS_API_KEY;
    if (!apiKey) throw new Error("Payment provider not configured");

    const apiBase =
      mode === "sandbox" ? "https://api-sandbox.nowpayments.io" : "https://api.nowpayments.io";

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
        order_description: `Veltrix ${plan.label} subscription${mode === "sandbox" ? " (TEST)" : ""}`,
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
