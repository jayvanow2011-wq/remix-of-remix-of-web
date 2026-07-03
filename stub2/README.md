# Android Agent Stub

Kotlin/Gradle project compiled by the build server into an APK.

## Placeholders
Same `{{PLACEHOLDER}}` pattern as the Rust stub. `build.py` renders them before running Gradle.

## Build Requirements
- JDK 17
- Android SDK with:
  - `platforms;android-34`
  - `build-tools;34.0.0`
  - Gradle wrapper (bundled in `gradle/wrapper/`)

## Feature Flags
Set via the builder UI and baked into `Binding.kt`:
- `FEATURE_SCREEN` — MediaProjection screen capture
- `FEATURE_CAMERA` — CameraX front/back
- `FEATURE_FILES` — File manager
- `FEATURE_MIC` — Microphone recording
- `FEATURE_LOCATION` — GPS/network location
- `FEATURE_SMS` — Read SMS inbox
- `FEATURE_CONTACTS` — Read contacts
- `FEATURE_NOTIFICATIONS` — Post notifications
- `FEATURE_INPUT` — Accessibility service input (tap/swipe/type)
- `FEATURE_STARTUP` — Boot receiver auto-start
