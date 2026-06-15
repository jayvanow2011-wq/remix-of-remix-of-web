import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useSingleSession } from "@/lib/single-session";
import { useSubscription } from "@/lib/use-subscription";
import { CountdownBadge } from "@/components/SubscriptionLock";
import { getProfile, type Profile } from "@/lib/profile";
import {
  LayoutDashboard, Users, LogOut, Wrench, Lock, CreditCard,
  MessagesSquare, Bell, Settings as SettingsIcon, ShieldCheck, MessageCircle, Gift,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCustomization } from "@/lib/customization-context";
import { NavMusicWidget } from "@/components/NavMusicWidget";

export const Route = createFileRoute("/dashboard")({
  component: DashboardLayout,
});

function DashboardLayout() {
  const navigate = useNavigate();
  const { authed, loading, user, signOut } = useAuth();
  const { location } = useRouterState();
  const { conflict, takeOver, cancel } = useSingleSession(user?.id);
  const sub = useSubscription(user?.id);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const { customization } = useCustomization();

  useEffect(() => {
    if (!loading && !authed) navigate({ to: "/" });
  }, [loading, authed, navigate]);

  useEffect(() => {
    if (!user) return;
    getProfile(user.id).then((p) => {
      setProfile(p);
      if (p && !p.profile_completed) navigate({ to: "/profile-setup" });
    });
    supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user, navigate]);

  const handleLogout = async () => {
    await signOut();
    navigate({ to: "/" });
  };

  const baseNav = [
    { to: "/dashboard", label: "Overview", icon: LayoutDashboard, exact: true },
    { to: "/dashboard/clients", label: "Clients", icon: Users, exact: false },
    { to: "/dashboard/builder", label: "Builder", icon: Wrench, exact: false },
    { to: "/dashboard/chat", label: "Chat", icon: MessageCircle, exact: false },
    { to: "/dashboard/community", label: "Community", icon: MessagesSquare, exact: false },
    { to: "/dashboard/refer", label: "Refer", icon: Gift, exact: false },
    { to: "/dashboard/notifications", label: "Notifications", icon: Bell, exact: false },
    { to: "/dashboard/subs", label: "Subscriptions", icon: CreditCard, exact: false },
    { to: "/dashboard/settings", label: "Settings", icon: SettingsIcon, exact: false },
    ...(isAdmin
      ? [{ to: "/dashboard/admin", label: "Admin", icon: ShieldCheck, exact: false }]
      : []),
  ];

  // Apply user-customised order + visibility
  const orderMap = new Map(customization.navOrder.map((p, i) => [p, i]));
  const hidden = new Set(customization.navHidden);
  const nav = baseNav
    .filter((n) => !hidden.has(n.to) || n.to === "/dashboard/settings") // never hide settings
    .sort((a, b) => {
      const ai = orderMap.has(a.to) ? orderMap.get(a.to)! : 999;
      const bi = orderMap.has(b.to) ? orderMap.get(b.to)! : 999;
      return ai - bi;
    });

  // Routes always available even when sub is locked
  const ALLOW_WHEN_LOCKED = ["/dashboard/subs", "/dashboard/settings", "/dashboard/refer", "/dashboard/notifications", "/dashboard/admin"];
  const [lockPopup, setLockPopup] = useState<string | null>(null);

  if (loading || !authed) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex min-h-screen flex-col">
      {conflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl animate-in fade-in zoom-in-95">
            <h2 className="text-lg font-semibold">Already signed in elsewhere</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Your account is active in another browser{conflict.user_agent ? ` (${conflict.user_agent.slice(0, 40)}…)` : ""}. Log out the other session?
            </p>
            <div className="mt-4 flex gap-2">
              <button onClick={cancel} className="flex-1 rounded-md border border-border bg-secondary px-4 py-2 text-sm transition hover:bg-accent">No, cancel</button>
              <button onClick={takeOver} className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90">Yes, take over</button>
            </div>
          </div>
        </div>
      )}
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="flex h-14 items-center justify-between px-5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold tracking-tight font-mono">fudrat.lol</span>
          </div>
          <div className="flex items-center gap-2">
            {!sub.loading && <CountdownBadge msLeft={sub.msLeft} />}
            <NavMusicWidget />
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="h-8 w-8 rounded-full object-cover border border-border" />
            ) : <div className="h-8 w-8 rounded-full bg-muted" />}
            <div className="hidden sm:block min-w-0">
              <div className="truncate text-xs font-medium">{profile?.username ?? "—"}</div>
            </div>
            <button onClick={handleLogout} className="ml-1 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground" title="Sign out">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto border-t border-border px-3 py-1.5 scrollbar-thin">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = item.exact ? location.pathname === item.to : location.pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`group flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition ${
                  active
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5 transition group-hover:scale-110" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="flex-1 p-4 sm:p-6 lg:p-8 relative">
        <Outlet />
      </main>
      {lockPopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4" onClick={() => setLockPopup(null)}>
          <div className="max-w-sm rounded-2xl border border-destructive/40 bg-card p-6 shadow-2xl text-center animate-in fade-in zoom-in-95" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/15 text-destructive">
              <Lock className="h-6 w-6" />
            </div>
            <h2 className="mt-3 text-lg font-semibold">Can't access "{lockPopup}"</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {sub.expiresAt
                ? `Your license expired on ${sub.expiresAt.toLocaleString()}.`
                : "You don't have an active license."}
              {" "}Renew at the Subscriptions page to unlock.
            </p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setLockPopup(null)} className="flex-1 rounded-md border border-border bg-secondary px-4 py-2 text-sm hover:bg-accent">Close</button>
              <button onClick={() => { setLockPopup(null); navigate({ to: "/dashboard/subs" }); }} className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
                <CreditCard className="h-3.5 w-3.5" /> Buy license
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

