/**
 * Supabase I/O for cloud sync: the client, email + password sign-in, and the
 * reads and writes on `public.dayflow_records`. The rules for what to pull and
 * push live in `lib/cloudRecords`; this file only talks to the network.
 */
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { chunkRows, type CloudRow, type CloudRowMeta } from '../lib/cloudRecords';
import { isNative } from '../lib/platform';

export const RECORDS_TABLE = 'dayflow_records';
const MIGRATION_FILE = 'supabase/migrations/20261114120000_dayflow_records.sql';
const PAGE_SIZE = 1000;
const IDS_PER_FETCH = 100;

export interface CloudAccount {
  id: string;
  email: string;
}

export interface CloudCheckStep {
  step: string;
  ok: boolean;
  message: string;
}

/** The session is missing or expired; the user has to sign in again. */
export class CloudAuthError extends Error {
  constructor(message = 'Your session ended. Sign in again to keep syncing.') {
    super(message);
    this.name = 'CloudAuthError';
  }
}

const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';

let client: SupabaseClient | null = null;

export function isCloudConfigured(): boolean {
  return Boolean(url && key);
}

export function getSupabase(): SupabaseClient | null {
  if (!isCloudConfigured()) return null;
  if (!client) {
    client = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // The website signs in from the email confirmation link. The Android
        // app has no web address for that link to return to.
        detectSessionInUrl: !isNative(),
        storageKey: 'dayflow-supabase-auth',
      },
    });
  }
  return client;
}

function requireClient(): SupabaseClient {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Cloud sync is not configured for this build.');
  return supabase;
}

export function accountOf(session: Session | null): CloudAccount | null {
  if (!session?.user) return null;
  return { id: session.user.id, email: session.user.email ?? '' };
}

/** True when a saved session exists, without waiting for the client to load it. */
export function hasStoredSession(): boolean {
  try {
    return Boolean(localStorage.getItem('dayflow-supabase-auth'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Errors in plain words
// ---------------------------------------------------------------------------

interface ErrorLike {
  code?: string;
  message?: string;
  status?: number;
}

export function describeAuthError(error: unknown): string {
  const e = (error ?? {}) as ErrorLike;
  switch (e.code) {
    case 'invalid_credentials':
      return 'Wrong email or password.';
    case 'email_not_confirmed':
      return 'Confirm your email first: open the link Supabase sent you, then sign in.';
    case 'user_already_exists':
      return 'An account with this email already exists. Sign in instead.';
    case 'weak_password':
      return e.message || 'Choose a longer password.';
    case 'email_address_invalid':
      return 'That email address is not valid.';
    case 'over_email_send_rate_limit':
      return 'Too many emails were sent. Wait a while, then try again.';
    case 'over_request_rate_limit':
      return 'Too many attempts. Wait a minute, then try again.';
    case 'signup_disabled':
      return 'New sign-ups are turned off for this project.';
    case 'email_provider_disabled':
      return 'Email sign-in is turned off in the Supabase project.';
    default:
      break;
  }
  if (isNetworkError(e)) return 'Can’t reach Supabase. Check your connection.';
  return e.message || 'Sign-in failed.';
}

function isNetworkError(e: ErrorLike): boolean {
  return /failed to fetch|network|load failed|fetch failed/i.test(e.message ?? '');
}

/** Turn a PostgREST error into something a person can act on. */
function toCloudError(error: ErrorLike): Error {
  const code = error.code ?? '';
  const message = error.message ?? '';
  if (code === 'PGRST301' || code === 'PGRST303' || error.status === 401 || /jwt/i.test(message)) {
    return new CloudAuthError();
  }
  if (code === 'PGRST205' || code === '42P01') {
    return new Error(`The ${RECORDS_TABLE} table is missing. Run ${MIGRATION_FILE} in the Supabase SQL editor.`);
  }
  if (code === '42501') {
    return new Error(
      `Signed-in users can’t use ${RECORDS_TABLE}. Run ${MIGRATION_FILE} again: it grants access and sets the row rules.`,
    );
  }
  if (isNetworkError(error)) return new Error('Can’t reach Supabase. Check your connection.');
  return new Error(message || 'Cloud sync failed.');
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function currentSession(): Promise<Session | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const { data, error } = await requireClient().auth.signInWithPassword({ email: email.trim(), password });
  if (error || !data.session) throw new Error(describeAuthError(error));
  return data.session;
}

/** Returns null when the project requires the email to be confirmed first. */
export async function signUp(email: string, password: string): Promise<Session | null> {
  const { data, error } = await requireClient().auth.signUp({
    email: email.trim(),
    password,
    options: isNative() ? undefined : { emailRedirectTo: window.location.origin },
  });
  if (error) throw new Error(describeAuthError(error));
  // An existing, confirmed email comes back with no identities instead of an error.
  if (data.user && data.user.identities?.length === 0) {
    throw new Error(describeAuthError({ code: 'user_already_exists' }));
  }
  return data.session;
}

export async function signOut(): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  // Local scope: sign this device out without ending sessions on the others.
  await supabase.auth.signOut({ scope: 'local' });
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Ids and versions of rows changed after `since` (all rows when null), oldest first. */
export async function pullRowMeta(userId: string, since: string | null): Promise<CloudRowMeta[]> {
  const supabase = requireClient();
  const rows: CloudRowMeta[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from(RECORDS_TABLE)
      .select('id, collection, updated_at, deleted, server_updated_at')
      .eq('user_id', userId)
      .order('server_updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (since) query = query.gt('server_updated_at', since);
    const { data, error } = await query;
    if (error) throw toCloudError(error);
    rows.push(...((data ?? []) as CloudRowMeta[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

/** Full rows (with data) for the given ids. */
export async function fetchRows(userId: string, ids: string[]): Promise<CloudRow[]> {
  const supabase = requireClient();
  const rows: CloudRow[] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_FETCH) {
    const { data, error } = await supabase
      .from(RECORDS_TABLE)
      .select('id, collection, data, updated_at, deleted')
      .eq('user_id', userId)
      .in('id', ids.slice(i, i + IDS_PER_FETCH));
    if (error) throw toCloudError(error);
    rows.push(...((data ?? []) as CloudRow[]));
  }
  return rows;
}

/** Upsert rows in batches. The server keeps whichever copy has the newer updated_at. */
export async function pushRows(userId: string, rows: CloudRow[]): Promise<void> {
  if (rows.length === 0) return;
  const supabase = requireClient();
  for (const chunk of chunkRows(rows)) {
    const { error } = await supabase
      .from(RECORDS_TABLE)
      .upsert(
        chunk.map((row) => ({ ...row, user_id: userId })),
        { onConflict: 'user_id,id' },
      );
    if (error) throw toCloudError(error);
  }
}

/** Walks configuration, session and table access, and names the step that fails. */
export async function testCloudConnection(): Promise<CloudCheckStep[]> {
  if (!isCloudConfigured()) {
    return [{ step: 'Setup', ok: false, message: 'VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY is missing from this build.' }];
  }
  const steps: CloudCheckStep[] = [{ step: 'Setup', ok: true, message: new URL(url).host }];

  let session: Session | null = null;
  try {
    session = await currentSession();
  } catch (e) {
    steps.push({ step: 'Account', ok: false, message: describeAuthError(e) });
    return steps;
  }
  if (!session) {
    steps.push({ step: 'Account', ok: false, message: 'Not signed in.' });
    return steps;
  }
  steps.push({ step: 'Account', ok: true, message: session.user.email ?? session.user.id });

  // Not a HEAD request: PostgREST sends no error body for HEAD, so a missing
  // table or grant would arrive without the code that explains it.
  const { count, error } = await requireClient()
    .from(RECORDS_TABLE)
    .select('id', { count: 'exact' })
    .eq('user_id', session.user.id)
    .limit(1);
  if (error) {
    steps.push({ step: 'Database', ok: false, message: toCloudError(error).message });
    return steps;
  }
  steps.push({ step: 'Database', ok: true, message: `${count ?? 0} records stored for this account.` });
  return steps;
}
