Big task — splitting into phases so you can OK before I burn credits on schema + flows.

## Phase 1 — Theme & layout (human-feeling)
- Tighter mono-driven CSS: snug spacing scale, no rounded blobs, sharp 1px borders, terminal-ish dividers (` ━━━ `, `[ section ]` labels), subtle scanline + grain overlay, asymmetric panels.
- Dashboard chrome: sidebar becomes a thin labeled rail (`> dash`, `> clients`, `> bio`), header strip with breadcrumbs as text path (`~/clients/$id`).
- Background: 3-color outline mode kept; add optional grain + faint dot grid that respects bg image.
- Motion: layout shift on route change (subtle slide+fade), button micro-press, input focus glow, copy-button checkmark pop. Tasteful, intensity ~3.
- Light slang copy sweep across primary surfaces (dash, clients, settings, auth).

## Phase 2 — Auth pages redesign
- `/` (login) + `/signup` split into separate routes, terminal-card look (header bar `┌─ veltrix ─┐`, prompt-style inputs `> username_`).
- Login: username + password + captcha, "forgot it?" link → `/recover`.
- Stepper UI for signup: `[1/4] account → [2/4] 2fa → [3/4] recovery → [4/4] profile`.

## Phase 3 — Signup flow (the real work)
1. **Step 1 — account**: username + password + captcha → "creating account..." loading (animated dots, fake-but-real progress), creates auth user.
2. **Step 2 — 2FA**: generate TOTP secret server-side, show QR + secret string, user scans (Microsoft Auth / Authy / Google Auth / any TOTP app), enters 6-digit code to verify and enable.
3. **Step 3 — recovery codes**: generate 8 single-use backup codes, show once, must click "I saved them" + type CONFIRM, then continue. Stored hashed.
4. **Step 4 — profile setup**: username (already set, can edit display name), avatar upload (existing `avatars` bucket), bio + socials (discord/telegram/twitter/website), pick plan (Trial / Pro / Lifetime — wires into existing `subscriptions` flow, paid ones link to checkout but selectable).
5. On finish → `/dashboard` with confetti-free, just a clean "you're in" sequence.

## Phase 4 — Login uses 2FA
- After password OK, if `totp_enabled`, prompt for 6-digit code OR recovery code (each recovery code consumed on use).

## Phase 5 — Biolinks redo
- **Editor** at `/dashboard/bio`: drag-reorder list of links (title + url + icon), live preview pane next to it (split). Theme picker for the public page (3 presets: terminal, minimal-card, neon).
- **Public** at `/u/$username`: full-page handcrafted layout — avatar, handle, bio, socials row, link buttons stacked, view count, no AI-template feel. Uses the user's chosen biolink theme.

## Schema changes (one migration)
- `profiles`: `totp_secret` (text, nullable, server-only read), `totp_enabled` (bool default false), `display_name` (text), `socials` (jsonb default `{}`), `bio_theme` (text default 'terminal').
- New `recovery_codes` table: `id`, `user_id`, `code_hash`, `used_at`. RLS: user reads own (count only via fn), service_role writes. Plus `consume_recovery_code(_code text)` SECURITY DEFINER fn.
- New `bio_links` table: `id`, `user_id`, `title`, `url`, `icon`, `position`, `created_at`. RLS: owner full, anon SELECT where profile is public.
- GRANTs + RLS per Lovable rules.

## Server functions
- `signup.functions.ts`: `createAccount`, `generateTotp`, `verifyTotpAndEnable`, `issueRecoveryCodes`, `finalizeProfile`.
- `auth.functions.ts`: `verifyLoginTotp` (called after password step).
- `bio.functions.ts`: `listMyLinks`, `upsertLink`, `deleteLink`, `reorderLinks`, `getPublicProfile(handle)`.

## Order of execution
1. Push migration (waits for your OK).
2. Theme + layout pass (Phase 1) — frontend only.
3. Auth pages redesign + signup flow (Phase 2 + 3 + 4) wired to new server fns.
4. Biolinks editor + public page (Phase 5).
5. Quick visual QA pass.

## What I need from you
- **OK to push the migration?** (totp_secret + recovery_codes + bio_links + 3 profile columns)
- **Plan selector**: which plans should appear at signup? Default I'll use: `Trial (3d free, auto)`, `Pro ($X/mo)`, `Lifetime ($Y)`. Tell me prices or "use existing plans" and I'll read them.
- **2FA library**: I'll use `otplib` + `qrcode` (pure JS, Worker-safe). OK?
