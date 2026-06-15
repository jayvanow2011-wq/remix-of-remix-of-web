import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const SESSION_KEY = "larping-tab-id";

function getOrCreateTabId() {
  if (typeof window === "undefined") return "";
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

export function useSingleSession(userId: string | undefined) {
  const [conflict, setConflict] = useState<{ session_id: string; user_agent?: string } | null>(null);
  const myId = useRef<string>("");

  useEffect(() => {
    if (!userId) return;
    myId.current = getOrCreateTabId();

    let cancelled = false;

    (async () => {
      const { data: existing } = await supabase
        .from("active_sessions")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();

      if (existing && existing.session_id !== myId.current) {
        setConflict({ session_id: existing.session_id, user_agent: existing.user_agent ?? undefined });
        return;
      }

      if (cancelled) return;
      await supabase.from("active_sessions").upsert({
        user_id: userId,
        session_id: myId.current,
        user_agent: navigator.userAgent,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    })();

    // Listen for kicks: if another tab takes over, sign us out
    const channel = supabase
      .channel(`active-session-${userId}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "active_sessions",
        filter: `user_id=eq.${userId}`,
      }, (payload) => {
        const newId = (payload.new as { session_id: string }).session_id;
        if (newId !== myId.current) {
          supabase.auth.signOut();
          window.location.href = "/?kicked=1";
        }
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const takeOver = async () => {
    if (!userId) return;
    await supabase.from("active_sessions").upsert({
      user_id: userId,
      session_id: myId.current,
      user_agent: navigator.userAgent,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    setConflict(null);
  };

  const cancel = async () => {
    await supabase.auth.signOut();
    window.location.href = "/";
  };

  return { conflict, takeOver, cancel };
}
