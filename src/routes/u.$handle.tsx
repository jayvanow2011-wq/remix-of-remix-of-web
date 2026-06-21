import { createFileRoute, notFound } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { getPublicBio, bumpClick, type BioLink } from "@/lib/bio.functions";
import { ExternalLink } from "lucide-react";

export const Route = createFileRoute("/u/$handle")({
  loader: async ({ params }) => {
    const r = await getPublicBio({ data: { handle: params.handle } });
    if (!r.profile) throw notFound();
    return r;
  },
  component: PublicBio,
  head: ({ loaderData }) => {
    const p = loaderData?.profile as { display_name?: string; full_name?: string; username?: string; bio?: string; avatar_url?: string } | null;
    if (!p) return { meta: [{ title: "not found" }] };
    const name = p.display_name || p.full_name || p.username || "user";
    return {
      meta: [
        { title: `@${p.username} — veltrixrat.xyz` },
        { name: "description", content: p.bio || `${name} on veltrixrat.xyz` },
        { property: "og:title", content: `@${p.username}` },
        { property: "og:description", content: p.bio || `${name} on veltrixrat.xyz` },
        ...(p.avatar_url ? [{ property: "og:image" as const, content: p.avatar_url }] : []),
      ],
    };
  },
  errorComponent: () => <main className="p-8 text-center text-sm text-muted-foreground">load failed.</main>,
  notFoundComponent: () => (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="term-frame max-w-sm">
        <div className="term-bar">~/404</div>
        <div className="term-body text-center font-mono text-sm">
          <div className="text-2xl">¯\_(ツ)_/¯</div>
          <div className="mt-2 text-muted-foreground">no one home at /u/{}</div>
        </div>
      </div>
    </main>
  ),
});

function PublicBio() {
  const { profile, links } = Route.useLoaderData();
  const click = useServerFn(bumpClick);
  const p = profile as unknown as {
    username: string; full_name?: string; display_name?: string;
    avatar_url?: string; bio?: string;
    socials?: Record<string, string>; bio_theme?: "terminal" | "card" | "neon";
  };
  const theme = p.bio_theme ?? "terminal";
  const name = p.display_name || p.full_name || p.username;

  const onClickLink = async (l: BioLink) => {
    try { await click({ data: { id: l.id } }); } catch { /* nbd */ }
    window.open(l.url, "_blank", "noopener");
  };

  return (
    <main className={`min-h-screen px-4 py-10 bio-theme-${theme}`}>
      <div className="mx-auto max-w-md space-y-4">
        <div className="text-center font-mono text-[10px] text-muted-foreground">veltrix.xyz/u/{p.username}</div>
        <div className="term-frame">
          <div className="term-bar">~/u/{p.username}</div>
          <div className="term-body space-y-4 text-center">
            {p.avatar_url ? (
              <img src={p.avatar_url} className="mx-auto h-20 w-20 object-cover border border-primary" />
            ) : (
              <div className="mx-auto flex h-20 w-20 items-center justify-center border border-border font-mono text-xs text-muted-foreground">no pfp</div>
            )}
            <div>
              <div className="font-mono text-base">{name}</div>
              <div className="font-mono text-[11px] text-muted-foreground">@{p.username}</div>
            </div>
            {p.bio && <p className="text-sm text-muted-foreground">{p.bio}</p>}
            {p.socials && Object.entries(p.socials).some(([,v]) => v) && (
              <div className="flex flex-wrap justify-center gap-1 text-[11px]">
                {Object.entries(p.socials).filter(([,v]) => v).map(([k,v]) => (
                  <span key={k} className="border border-border px-2 py-0.5 font-mono">
                    <span className="text-primary">{k}:</span>{String(v)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          {(links as BioLink[]).map((l) => (
            <button key={l.id} onClick={() => onClickLink(l)} className="bio-link w-full">
              <span className="truncate text-left font-mono text-sm">{l.title}</span>
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          ))}
          {(links as BioLink[]).length === 0 && (
            <div className="text-center font-mono text-[11px] text-muted-foreground">no links yet</div>
          )}
        </div>

        <div className="text-center font-mono text-[10px] text-muted-foreground">
          made on <a href="/" className="text-primary hover:underline">veltrix</a>
        </div>
      </div>
    </main>
  );
}