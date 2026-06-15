// Server-side health check for the HidenHost relay.
//
// Pings the relay's `/health` endpoint from the server (so the URL never
// reaches the browser) and returns only `{ ok, ms }`. The /status page
// shows just "Backend: Online — 42 ms" or "Backend: Offline".

import { createServerFn } from "@tanstack/react-start";

const RELAY_URL = "https://veltrix.hidenfree.com";
const TIMEOUT_MS = 4000;

export type RelayHealth = {
  ok: boolean;
  ms: number | null;
};

export const checkRelayHealth = createServerFn({ method: "GET" }).handler(
  async (): Promise<RelayHealth> => {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${RELAY_URL}/health`, {
        method: "GET",
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      const ms = Date.now() - started;
      if (!res.ok) return { ok: false, ms };
      // Body is small — drain it so the connection can be pooled.
      try { await res.json(); } catch { /* ignore */ }
      return { ok: true, ms };
    } catch {
      return { ok: false, ms: null };
    } finally {
      clearTimeout(timer);
    }
  },
);
