/**
 * Import from other password managers' CSV exports: Chrome / Google Password
 * Manager (name,url,username,password,note) and Bitwarden (folder,favorite,
 * type,name,notes,...,login_uri,login_username,login_password,login_totp).
 * The CSV is plaintext, so it is read in memory and never stored.
 */
import { checkVaultEntry } from './passwordVault';
import type { VaultEntry } from './passwordVault';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index++;
      row.push(field);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

export interface ImportResult {
  format: 'chrome' | 'bitwarden';
  entries: VaultEntry[];
  /** Rows left out: empty, unsupported type, or a field too long. */
  skipped: number;
}

function hostTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function importPasswordCsv(text: string, makeId: () => string = () => crypto.randomUUID()): ImportResult {
  if (text.length > MAX_IMPORT_BYTES) throw new Error('The file is larger than 5 MB.');
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new Error('The file is empty.');
  const columns = header.map((name) => name.trim().toLowerCase());
  const col = (name: string) => columns.indexOf(name);
  const isBitwarden = col('login_password') >= 0;
  const isChrome = !isBitwarden && col('password') >= 0 && (col('url') >= 0 || col('name') >= 0);
  if (!isBitwarden && !isChrome) {
    throw new Error('Choose a CSV exported from Chrome, Google Password Manager or Bitwarden.');
  }
  const entries: VaultEntry[] = [];
  let skipped = 0;
  for (const row of rows) {
    const get = (name: string) => (col(name) >= 0 ? (row[col(name)] ?? '').trim() : '');
    let entry: VaultEntry;
    if (isBitwarden) {
      const type = get('type') || 'login';
      if (type !== 'login' && type !== 'note') {
        skipped++;
        continue;
      }
      const website = get('login_uri').split(/[\n,]/)[0]?.trim() ?? '';
      entry = {
        id: makeId(),
        title: get('name') || hostTitle(website),
        website,
        username: get('login_username'),
        password: get('login_password'),
        notes: get('notes'),
        kind: type === 'note' ? 'note' : 'login',
        category: get('folder').slice(0, 40) || undefined,
        favorite: get('favorite') === '1' || undefined,
        totp: get('login_totp') || undefined,
      };
    } else {
      const website = get('url');
      entry = {
        id: makeId(),
        title: get('name') || hostTitle(website),
        website,
        username: get('username'),
        password: get('password'),
        notes: get('note') || get('notes'),
      };
    }
    try {
      entries.push(checkVaultEntry(entry));
    } catch {
      skipped++;
    }
  }
  return { format: isBitwarden ? 'bitwarden' : 'chrome', entries, skipped };
}
