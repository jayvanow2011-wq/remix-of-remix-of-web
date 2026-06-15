import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type CommandRow = {
  id: string;
  device_id: string;
  action: string;
  payload: any;
  status: "pending" | "running" | "done" | "error";
  result: any;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

type Waiter = {
  resolve: (r: CommandRow) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Send a command, await its completion via realtime UPDATE with poll fallback.
 */
export function useDeviceCommands(deviceId: string) {
  const waiters = useRef<Map<string, Waiter>>(new Map());
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    const ch = supabase
      .channel(`cmd-${deviceId}-${Math.random().toString(36).slice(2, 10)}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "commands",
          filter: `device_id=eq.${deviceId}`,
        },
        (payload) => {
          const row = payload.new as CommandRow;
          if (row.status !== "done" && row.status !== "error") return;
          const w = waiters.current.get(row.id);
          if (!w) return;
          clearTimeout(w.timer);
          waiters.current.delete(row.id);
          if (row.status === "error") {
            w.reject(new Error(row.error || "Command failed on agent"));
          } else {
            w.resolve(row);
          }
        },
      )
      .subscribe((status) => {
        setConnected(status === "SUBSCRIBED");
      });
    return () => {
      supabase.removeChannel(ch);
    };
  }, [deviceId]);

  // Poll fallback — if realtime misses an update, poll periodically
  const pollForResult = useCallback(
    async (cmdId: string, maxAttempts = 6, intervalMs = 2000): Promise<CommandRow | null> => {
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, intervalMs));
        const { data } = await supabase
          .from("commands")
          .select("*")
          .eq("id", cmdId)
          .maybeSingle();
        if (data && (data.status === "done" || data.status === "error")) {
          return data as CommandRow;
        }
      }
      return null;
    },
    [],
  );

  const send = useCallback(
    async (action: string, payload: any = {}, timeoutMs = 30000): Promise<CommandRow> => {
      const { data, error } = await supabase
        .from("commands")
        .insert({ device_id: deviceId, action, payload })
        .select("id")
        .single();
      if (error) throw new Error(`Failed to send command: ${error.message}`);
      const id = data.id as string;

      return new Promise<CommandRow>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.current.delete(id);
          // Try poll fallback before giving up
          pollForResult(id, 3, 1500)
            .then((row) => {
              if (row) {
                if (row.status === "error") {
                  reject(new Error(row.error || "Command failed"));
                } else {
                  resolve(row);
                }
              } else {
                reject(new Error("Command timed out — device may be offline"));
              }
            })
            .catch(() => reject(new Error("Command timed out — device may be offline")));
        }, timeoutMs);
        waiters.current.set(id, { resolve, reject, timer });
      });
    },
    [deviceId, pollForResult],
  );

  return { send, connected };
}
