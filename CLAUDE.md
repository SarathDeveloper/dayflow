# Dayflow

React 19 + Vite + Tailwind 4 app shipped as a PWA and as a Capacitor 8 Android
app. Local-first: all data lives in `localStorage` and syncs through Supabase
(one table, `public.dayflow_records`). **Login is required** when Supabase is
configured. Live site: https://dayflow-one-blue.vercel.app. See README.md for
features, setup and the Android release process.

## Commands

- `npm test`: Vitest, `src/**/*.test.ts` only (pure logic in `src/lib`)
- `npm run lint`: `tsc --noEmit`
- `npm run build:android`: web build + `cap sync android`
- `npm run publish:android`: after pushing `main`, publish the Android
  auto-update release (GitHub Release with app code zip, APK, `update.json`).
  Needs a clean tree at `origin/main`; `-- --dry-run` builds without publishing.
- Android Gradle needs the SDK path: `android/local.properties` (`sdk.dir=...`,
  git-ignored) or `ANDROID_HOME`. JDK 21.

## Layout

- `src/App.tsx` owns all state. It loads each collection from `localStorage`
  once, saves each back via `usePersistJson`, and reloads when a cloud merge
  bumps `dataEpoch`.
- `src/lib/`: pure, tested logic. Put new rules here, not in components.
- `src/services/`: platform code (Supabase I/O, notifications, plugin wrappers).
- Auth: `main.tsx` renders `components/auth/AuthGate` (driven by
  `hooks/useAuthGate.ts`), which mounts App only once a session exists. App
  can unmount on sign-out, so native listeners must detach even if they
  finish attaching after unmount (the `disposed` pattern in App.tsx).
- Cloud sync: `lib/cloudRecords.ts` (pure: envelope <-> rows, what to pull and
  push), `services/cloudSyncService.ts` (network), `hooks/useCloudSync.ts`
  (lifecycle). Schema in `supabase/migrations/`.
- Supabase is reached through the site's `/supabase` proxy (`vercel.json`),
  because some Indian networks block `*.supabase.co`.
- `android/.../dailytasks/`: native alarms (`AlarmScheduler`, ring service and
  screen, boot receiver) and home-screen widgets. Spoken reminders ("Voice"
  sound or "Voice announcements") are separate exact alarms (`SpeechScheduler`
  -> `DayflowSpeakService`, text-to-speech), synced with `syncSpeech` next to
  the ring sync in `pushNativeSchedule`; rules in `lib/spokenReminders.ts`. The
  test notification uses id 2147483647, which the task sync never owns.

## Rules that will bite if broken

- **Every edit must set `updatedAt` to now.** Cloud sync merges per record and
  the newer `updatedAt` wins (in the app and in the server trigger); an edit
  that keeps the old stamp is never pushed and loses the merge. Deletes
  need a tombstone (`markDeleted`); for a transfer use `idsRemovedByCascade` so
  its ATM fee goes too.
- **Money is stored in rupees and calculated in paise.** Add amounts with
  `addRupees` / `toPaise` from `lib/money.ts`, never `a + b` on rupee floats.
- **Borrowed / lent / repaid / received money is not income or spending.**
  Such ledger entries carry `debtId` + `debtRole` (`lib/moneyLinks.ts`). Count
  income and spending with `countsAsIncome` / `countsAsSpending`, never
  `tx.type === 'expense'`; only the Ledger list itself shows raw cash flow
  (`summarize(..., { cashFlow: true })`). Bills and debts link to their ledger
  entries both ways (`billPaymentId` / `transactionId`); after deleting or
  editing an entry, run `unlinkDeletedTransactions` / `syncEditedTransaction`.
- **Dates are local, never UTC.** Use `todayString()` / `currentMonthKey()` from
  `lib/ledger.ts` for days and months. `toISOString()` is only for timestamps
  (`createdAt`, `updatedAt`, ...): east of UTC it is still yesterday after midnight.
- **Weeks start on Sunday in the ledger** (`weekRange`) **and on Monday in habits.**
  This is intentional; do not mix the two helpers.
- **Values that must stay identical:**
  - Sample task ids `task-1..5` in `data/initialTasks.ts` and `STARTER_TASK_IDS`
    in `lib/singleProfile.ts` (tested in `singleProfile.test.ts`).
  - `smsFingerprint` in `lib/bankSmsParse.ts` and `BankSmsStore.fingerprint` in
    Java on `feature/bank-sms-notifications` (reference values pinned in
    `bankSmsParse.test.ts`).
- **Device-only data, never synced or backed up:** daily plan
  (`dayflow_daily_plan_v1`), app-lock flag (`dayflow_app_lock`) and the website
  lock's WebAuthn credential id (`dayflow_web_lock_credential_v1`), alarm song
  files (Android `filesDir/songs/`, website IndexedDB `dayflow-media`), bank SMS
  queue (`dayflow_bank_sms_*`), the document vault's plaintext reminder schedule
  (`dayflow_document_reminders_v1`: dates + random keys only, titles only if the
  user opts in; each device rebuilds it on open and after a sync) and
  decrypted copies the viewer, Share or Print hand out (Android `cache/shared/`,
  deleted after 15 minutes). A reminder's `songId` does sync, so it may name
  a song this device lacks: `pickSong` then falls back to the oldest song, then
  the chime. A new collection that should sync must be added to
  `SyncData` in `lib/persistence.ts`, `RECORD_COLLECTIONS` in
  `lib/cloudRecords.ts` and `BACKUP_ARRAY_KEYS` in `lib/backup.ts`.
- **The password vault syncs itself and has no passphrase (account key).** It
  is not in `SyncData`: `services/passwordVault.ts` pulls and pushes its own
  rows (collection `passwordVault`: header `__vault`, one `vault-<id>` row per
  item) and the main sync ignores rows of collections it does not know
  (`isForeignRow` in `lib/cloudRecords.ts`). Items are AES-GCM encrypted with
  their row id and `updatedAt` bound in (`lib/passwordVault.ts`), but the data
  key itself rides in the `__vault` header (`key`), so the server could read it:
  this is a product choice, not end-to-end. Older passphrase headers
  (`salt` + `wrappedKey`, and the pre-sync v1 Android file) convert once the
  passphrase is entered. The vault opens only when signed in; sign-out removes
  the device copy once synced. Backup files are v1 files locked with a password
  chosen at export. Local copy: Android plugin file, website localStorage
  `dayflow_password_vault_v2`.
- **The document vault has no passphrase (account key) and syncs itself.**
  Envelope version 2 keeps the data key in its header, so it opens without an
  unlock step and is not end-to-end. Version 1 (passphrase-wrapped key: older
  devices and every backup file, locked with a password chosen at export)
  converts with `upgradeDocumentVault`, keeping id and key so files stay valid.
  `services/documentSync.ts` copies the envelope (header + encrypted index) to
  `dayflow_document_vaults` (one row per user, written compare-and-swap on
  `revision`), each encrypted file to the private Storage bucket `document-vault`
  as `<user id>/<attachment id>.<part>` in parts of at most 3 MB (the `/supabase`
  proxy). A merge (both sides changed) uses the header's key; after any pulled
  change sync rebuilds the reminder schedule. A version 1 vault does not sync
  until converted. The local blob store must hold exactly the
  files the stored envelope refers to (every write in `services/documentStorage.ts`
  keeps that, and push builds its file list from it). Deleting a document
  records it in `deletedDocuments` (`removeDocument(index, id, now)`) so a merge
  cannot bring it back. Rules in `lib/documentSync.ts` (tested). It has its own
  backup and is not in the app backup.
- **Vault "ask for fingerprint" is device-only:** Android Keystore key + file
  `password-vault-bio.v1`, website passkey (WebAuthn PRF) in
  `dayflow_vault_passkey_v1`, prefs (auto-lock, last backup) in
  `dayflow_vault_prefs_v1`. Never sync or back these up.
- **Notification ids: tasks/habits use ids >= 0, document and maintenance
  reminders use ids < 0** (`lib/extraReminders.ts`). Each sync and cancel-all only
  touches its own range; keep it that way or one feature cancels the other's alarms.
- **System pickers background the app.** Wrap a file picker / save screen in
  `beginExternalActivity()` (`lib/externalActivity.ts`) so the app lock and the
  document vault do not lock mid-pick; the window is capped at 3 minutes.
- **Record ids must be unique across all collections.** Tombstones and the
  server row key are the id alone.
- **History is scored "as it was then".** Progress score, weekly report and
  recovery treat a habit as blocked only from `habitBlockedSince` (archived /
  goal paused or completed) onwards; a rest day is a habit check-in with
  `skipped: true` (future days accept only that, see `canSetCheckIn`).
- **Supabase keys:** only the URL and publishable key belong in the app (they
  are in the committed `.env`). Never the service_role / secret key.
- **Signed in = a saved session exists** (`storedAccount()`), not "the startup
  auth event had a session": offline refresh failures report no session but
  keep it saved. Keep `guardedFetch`: without it a non-JSON error page (Vercel
  404, captive portal) would make supabase-js delete the session.
- **Schema changes** go in a new file in `supabase/migrations/`; keep RLS on
  and grant `authenticated` explicitly (new tables are not exposed by default).
- **Bank SMS is off on `main`** (`VITE_ENABLE_BANK_SMS`). Its native listener
  exists only on `feature/bank-sms-notifications`; Play does not allow it.
