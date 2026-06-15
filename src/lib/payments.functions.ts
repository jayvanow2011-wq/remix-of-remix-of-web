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

    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    if (!apiKey) throw new Error("Payment provider not configured");

    const res = await fetch("https://api.nowpayments.io/v1/invoice", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        price_amount: plan.usd,
        price_currency: "usd",
        order_id: `${data.userId}__${data.planId}__${Date.now()}`,
        order_description: `Veltrix ${plan.label} subscription`,
        ipn_callback_url: "", // will be set when we add the webhook
        success_url: "",
        cancel_url: "",
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("NowPayments error", text);
      throw new Error("Payment creation failed");
    }

    const invoice = (await res.json()) as { id: string; invoice_url: string };
    return { invoiceUrl: invoice.invoice_url, invoiceId: String(invoice.id) };
  });
