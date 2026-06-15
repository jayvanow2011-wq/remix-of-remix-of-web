
# Phase 1: Core Setup & Features

## 1. Database: Admin user "jayjay" with password "jayjay100!"
- Create/update admin user in Supabase auth with email jayjay@veltrix.xyz, password jayjay100!
- Ensure user_roles has admin role for this user
- Ensure profile exists with username "jayjay"

## 2. Config & URLs
- Update `buildserver/config.json` with correct new project URLs (the remixed project ID `5a812085-735a-438c-8ab0-793e6374dce4`)
- Update `agent/rust/src/binding.rs` SENTINEL_SERVER to new project URL
- Update all API endpoint references

## 3. Stub Updates — Two Stubs
- Create a "lite" stub (no fun features) and a "full" stub (with fun features)
- Update `/api/public/buildserver/stub.ts` to serve both, selected by query param `?variant=lite|full`
- Fun features in full stub: message box, wallpaper change, open URL, play sound, flip screen, hide taskbar, mouse/keyboard control, GDI draw
- Builder page gets toggle for fun features which picks the right stub variant

## 4. License Redirect
- On every page load (except admin users and /dashboard/subs), check subscription status
- If expired, redirect to `/dashboard/subs`
- Admin users bypass this check

## 5. Secret /FREE Page
- New route `/FREE` — first 5 logged-in users who visit get lifetime access
- Create DB table `free_claims` to track claims (max 5 rows)
- Show remaining spots count, success/failure message

## 6. Ads/Spots Page (Fixed Slots)
- New table `ad_spots` with: slot_number, title, short_description, long_description, images (jsonb), buttons (jsonb), owner_username, is_for_sale, created_by_admin
- Admin can create spots (fixed number, e.g. 10), mark for sale, assign to user by username search
- Public page `/dashboard/ads` shows grid of spots with front image + short desc
- Click opens full detail: all images, full description, action buttons
- Spot owner can edit their assigned spot

## 7. 2FA TOTP
- Already partially implemented (see `src/lib/totp.functions.ts`)
- Wire TOTP verification into login flow — after email/password, prompt for 6-digit code
- Settings page to enable/disable 2FA with QR code setup

## 8. Control Page Improvements
- Dark theme only, minimal colors, use website theme tokens
- Camera: detect cameras, toast "No cameras found" if none, selector if multiple
- Desktop/screen: same detection pattern
- Mouse/keyboard: ensure no crashes, proper error handling
- GDI Draw: color picker + thickness slider, draws to agent screen
- All panels use low-contrast dark theme styling

## Technical Details
- New migration for `free_claims` and `ad_spots` tables with RLS
- Update stub.ts to support two variants
- Update builder page for fun feature toggle
- License check in dashboard layout component
