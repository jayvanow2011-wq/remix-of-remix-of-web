import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { generateRecoveryToken } from "@/lib/recovery-token";
import {
  setRecoveryToken,
  recoverWithToken,
  lookupEmailByUsername,
} from "@/lib/recovery.functions";

type AuthState = {
  authed: boolean;
  loading: boolean;
  user: User | null;
  session: Session | null;
  signInWithUsername: (username: string, password: string) => Promise<{ error?: string }>;
  signUpWithUsername: (
    username: string,
    password: string,
    refCode?: string,
  ) => Promise<{ error?: string; recoveryToken?: string }>;
  recoverAccount: (
    username: string,
    token: string,
    newPassword: string,
  ) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

const USERNAME_DOMAIN = "veltrix.xyz";

function usernameToFallbackEmail(username: string) {
  const u = username.toLowerCase().trim();
  if (u.includes("@")) return u;
  return `${u}@${USERNAME_DOMAIN}`;
}

async function resolveEmail(username: string): Promise<string> {
  const u = username.trim();
  if (u.includes("@")) return u.toLowerCase();
  try {
    const { email } = await lookupEmailByUsername({ data: { username: u } });
    if (email) return email;
  } catch {
    // fall through
  }
  return usernameToFallbackEmail(u);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
    });
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      setLoading(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  const signInWithUsername = async (username: string, password: string) => {
    const email = await resolveEmail(username);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? { error: error.message } : {};
  };

  const signUpWithUsername = async (username: string, password: string, refCode?: string) => {
    const u = username.trim();
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(u)) {
      return { error: "Username must be 3-20 chars (letters, numbers, _)" };
    }
    const meta: Record<string, string> = { username: u, full_name: u };
    if (refCode && /^[A-Z0-9]{4,16}$/i.test(refCode)) meta.ref_code = refCode.toUpperCase();
    const email = usernameToFallbackEmail(u);
    const { data: signUpData, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/dashboard`,
        data: meta,
      },
    });
    if (error) return { error: error.message };

    // Generate recovery token + store hash server-side
    const token = generateRecoveryToken();
    const uid = signUpData.user?.id;
    if (uid) {
      try {
        await setRecoveryToken({ data: { userId: uid, token } });
        await supabase.from("profiles").update({ username: u, full_name: u }).eq("id", uid);
      } catch (e) {
        console.warn("recovery token persist failed", e);
      }
    }
    return { recoveryToken: token };
  };

  const recoverAccount = async (username: string, token: string, newPassword: string) => {
    try {
      const { email } = await recoverWithToken({
        data: { username, token, newPassword },
      });
      if (!email) return { error: "Account not found" };
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email,
        password: newPassword,
      });
      if (signInErr) return { error: signInErr.message };
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Recovery failed" };
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        authed: !!session,
        loading,
        user,
        session,
        signInWithUsername,
        signUpWithUsername,
        recoverAccount,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
