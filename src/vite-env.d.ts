/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL, e.g. https://<ref>.supabase.co. Needed for cloud sync. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase publishable (or legacy anon) key. Safe in the app; RLS protects the data. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** "true" shows the bank-spend inbox. Needs the native listener from feature/bank-sms-notifications. */
  readonly VITE_ENABLE_BANK_SMS?: string;
  /** Set by scripts/release-android.mjs: the app-code version of a published release. */
  readonly VITE_APP_BUILD?: string;
  /** Set by Vercel on its builds: the deployed commit, sent with crash reports. */
  readonly VITE_VERCEL_GIT_COMMIT_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
