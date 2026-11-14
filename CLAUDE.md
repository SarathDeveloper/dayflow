# Dayflow

React 19 + Vite + Tailwind 4 app shipped as a PWA and as a Capacitor 8 Android
app. Local-first: all data lives in `localStorage`, with optional cloud sync
through Supabase (one table, `public.dayflow_records`). See README.md for
features, setup and the Android release process.

## Commands

- `npm test`: Vitest, `src/**/*.test.ts` only (pure logic in `src/lib`)
- `npm run lint`: `tsc --noEmit`
- `npm run build:android`: web build + `cap sync android`
- Android Gradle needs the SDK path: `android/local.properties` (`sdk.dir=...`,
  git-ignored) or `ANDROID_HOME`. JDK 21.

## Layout

- `src/App.tsx` owns all state. It loads each collection from `localStorage`
  once, saves each back via `usePersistJson`, and reloads when a cloud merge
  bumps `dataEpoch`.
- `src/lib/`: pure, tested logic. Put new rules here, not in components.
- `src/services/`: platform code (Supabase I/O, notifications, plugin wrappers).
- Cloud sync: `lib/cloudRecords.ts` (pure: envelope <-> rows, what to pull and
  push), `services/cloudSyncService.ts` (network), `hooks/useCloudSync.ts`
  (lifecycle). Schema in `supabase/migrations/`.
- `android/.../dailytasks/`: native alarms (`AlarmScheduler`, ring service and
  screen, boot receiver) and home-screen widgets.

## Rules that will bite if broken

- **Every edit must set `updatedAt` to now.** Cloud sync merges per record and
  the newer `updatedAt` wins (in the app and in the server trigger); an edit
  that keeps the old stamp is never pushed and loses the merge. Deletes
  need a tombstone (`markDeleted`); for a transfer use `idsRemovedByCascade` so
  its ATM fee goes too.
- **Money is stored in rupees and calculated in paise.** Add amounts with
  `addRupees` / `toPaise` from `lib/money.ts`, never `a + b` on rupee floats.
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
  (`dayflow_daily_plan_v1`), app-lock flag (`dayflow_app_lock`), bank SMS queue
  (`dayflow_bank_sms_*`). A new collection that should sync must be added to
  `SyncData` in `lib/persistence.ts`, `RECORD_COLLECTIONS` in
  `lib/cloudRecords.ts` and `BACKUP_ARRAY_KEYS` in `lib/backup.ts`.
- **Record ids must be unique across all collections.** Tombstones and the
  server row key are the id alone.
- **Supabase keys:** only the URL and publishable key belong in the app (they
  are in the committed `.env`). Never the service_role / secret key.
- **Schema changes** go in a new file in `supabase/migrations/`; keep RLS on
  and grant `authenticated` explicitly (new tables are not exposed by default).
- **Bank SMS is off on `main`** (`VITE_ENABLE_BANK_SMS`). Its native listener
  exists only on `feature/bank-sms-notifications`; Play does not allow it.
