import { describe, expect, it } from 'vitest';
import {
  SETTINGS_ROW_ID,
  advanceCursor,
  buildPushRows,
  chunkRows,
  idsToDownload,
  localVersions,
  pullStart,
  reconcile,
  restoreFromRows,
  rowsToEnvelope,
  sameSnapshot,
  type CloudRow,
  type CloudRowMeta,
} from './cloudRecords';
import { DATA_SCHEMA_VERSION, DEFAULT_SETTINGS, type SyncData, type SyncEnvelope } from './persistence';
import { RECORD_COLLECTIONS, initialSyncMode, isAccountSwitch } from './cloudRecords';
import type { Task } from '../types';

const T = (minute: number) => new Date(Date.UTC(2026, 10, 14, 10, minute)).toISOString();

function task(id: string, minute: number, title = id): Task {
  return {
    id,
    title,
    completed: false,
    date: '2026-11-14',
    priority: 'medium',
    category: 'cat-1',
    subtasks: [],
    recurrence: { type: 'none' },
    reminder: { enabled: false, remindBeforeMinutes: 0, sound: 'chime' },
    createdAt: T(0),
    updatedAt: T(minute),
  };
}

function envelope(data: Partial<SyncData> = {}, extra: Partial<SyncEnvelope> = {}): SyncEnvelope {
  const base = { settings: DEFAULT_SETTINGS } as SyncData;
  for (const collection of RECORD_COLLECTIONS) {
    (base as unknown as Record<string, unknown[]>)[collection] = [];
  }
  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    deviceId: 'device',
    updatedAt: T(0),
    settingsUpdatedAt: '',
    tombstones: {},
    ...extra,
    data: { ...base, ...data },
  };
}

/**
 * In-memory stand-in for public.dayflow_records with the same rules as the SQL
 * trigger: older copies are ignored, identical re-sends change nothing, and
 * every accepted write gets a fresh, increasing server time.
 */
class FakeServer {
  rows = new Map<string, CloudRow & { server_updated_at: string }>();
  private clock = Date.UTC(2026, 10, 14, 12, 0);

  upsert(rows: CloudRow[]) {
    for (const row of rows) {
      const old = this.rows.get(row.id);
      if (old) {
        if (Date.parse(row.updated_at) < Date.parse(old.updated_at)) continue;
        if (
          row.updated_at === old.updated_at &&
          row.deleted === old.deleted &&
          JSON.stringify(row.data) === JSON.stringify(old.data)
        ) {
          continue;
        }
      }
      this.clock += 1000;
      this.rows.set(row.id, {
        ...row,
        collection: row.collection ?? old?.collection ?? null,
        data: row.deleted ? null : row.data,
        server_updated_at: new Date(this.clock).toISOString(),
      });
    }
  }

  meta(since: string | null): CloudRowMeta[] {
    return [...this.rows.values()]
      .filter((row) => !since || Date.parse(row.server_updated_at) > Date.parse(since))
      .map(({ id, collection, updated_at, deleted, server_updated_at }) => ({
        id,
        collection,
        updated_at,
        deleted,
        server_updated_at,
      }));
  }

  fetch(ids: string[]): CloudRow[] {
    return ids.map((id) => this.rows.get(id)!).map(({ server_updated_at: _, ...row }) => row);
  }
}

/** What useCloudSync does for one merge sync, against the fake server. */
function syncDevice(device: { envelope: SyncEnvelope; cursor?: string; pushedAt?: string }, server: FakeServer, now: string) {
  const meta = server.meta(pullStart(device.cursor));
  const rows = server.fetch(idsToDownload(meta, localVersions(device.envelope)));
  const { merged, push } = reconcile(device.envelope, { meta, rows }, device.pushedAt);
  server.upsert(push);
  device.envelope = merged;
  device.cursor = advanceCursor(device.cursor, meta);
  device.pushedAt = now;
  return push;
}

describe('buildPushRows', () => {
  it('uploads every record, tombstone and edited settings on the first push', () => {
    const local = envelope(
      { tasks: [task('t-1', 1)], settings: { ...DEFAULT_SETTINGS, soundEnabled: false } },
      { tombstones: { 'old-1': T(2) }, settingsUpdatedAt: T(3) },
    );
    const rows = buildPushRows(local, undefined, new Map());
    expect(rows.map((r) => [r.id, r.collection, r.deleted])).toEqual([
      ['t-1', 'tasks', false],
      ['old-1', null, true],
      [SETTINGS_ROW_ID, 'settings', false],
    ]);
    expect(rows[1].data).toBeNull();
  });

  it('uploads only what changed since the last push, minus what the server has', () => {
    const local = envelope({ tasks: [task('a', 1), task('b', 5), task('c', 6)] });
    const rows = buildPushRows(local, T(4), new Map([['c', Date.parse(T(6))]]));
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  it('never uploads an untouched sample day', () => {
    const starter = ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'].map((id) => task(id, 1));
    expect(buildPushRows(envelope({ tasks: starter }), undefined, new Map())).toEqual([]);
  });

  it('skips a tombstone when the same id was saved again after the delete', () => {
    const local = envelope({ budgets: [{ id: 'budget-2026-11', month: '2026-11', limit: 5, updatedAt: T(9) }] }, { tombstones: { 'budget-2026-11': T(5) } });
    const rows = buildPushRows(local, undefined, new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'budget-2026-11', deleted: false });
  });

  it('does not upload settings that were never edited', () => {
    expect(buildPushRows(envelope(), undefined, new Map())).toEqual([]);
  });
});

describe('pull helpers', () => {
  it('downloads only live rows newer than this device holds', () => {
    const local = envelope({ tasks: [task('same', 5), task('older', 5)] }, { tombstones: { gone: T(1) } });
    const meta: CloudRowMeta[] = [
      { id: 'same', collection: 'tasks', updated_at: T(5), deleted: false, server_updated_at: T(30) },
      { id: 'older', collection: 'tasks', updated_at: T(7), deleted: false, server_updated_at: T(31) },
      { id: 'new', collection: 'tasks', updated_at: T(1), deleted: false, server_updated_at: T(32) },
      { id: 'gone', collection: 'tasks', updated_at: T(2), deleted: true, server_updated_at: T(33) },
      { id: 'future', collection: 'notAThing', updated_at: T(9), deleted: false, server_updated_at: T(34) },
    ];
    expect(idsToDownload(meta, localVersions(local))).toEqual(['older', 'new']);
  });

  it('looks back a minute before the cursor, and moves the cursor forward only', () => {
    expect(pullStart(undefined)).toBeNull();
    expect(pullStart(T(10))).toBe(T(9));
    const meta = [{ server_updated_at: T(12) }, { server_updated_at: T(11) }] as CloudRowMeta[];
    expect(advanceCursor(T(10), meta)).toBe(T(12));
    expect(advanceCursor(T(20), meta)).toBe(T(20));
  });

  it('keeps local settings unless the cloud sent a settings row', () => {
    const local = envelope({}, { settingsUpdatedAt: T(1) });
    expect(rowsToEnvelope([], local).settingsUpdatedAt).toBe('');
    const remote = rowsToEnvelope(
      [{ id: SETTINGS_ROW_ID, collection: 'settings', data: { soundEnabled: false }, updated_at: T(5), deleted: false }],
      local,
    );
    expect(remote.data.settings.soundEnabled).toBe(false);
    expect(remote.data.settings.defaultSound).toBe(DEFAULT_SETTINGS.defaultSound);
    expect(remote.settingsUpdatedAt).toBe(T(5));
  });

  it('batches by size and still sends one oversized row alone', () => {
    const big = { id: 'big', collection: 'diaryEntries', data: { body: 'x'.repeat(2000) }, updated_at: T(1), deleted: false };
    const small = { ...big, id: 's', data: { body: 'y' } };
    expect(chunkRows([small, big, small], 1000).map((c) => c.map((r) => r.id))).toEqual([['s'], ['big'], ['s']]);
  });
});

describe('two devices syncing through the server', () => {
  it('converge after edits and deletes on both sides', () => {
    const server = new FakeServer();
    const phone = { envelope: envelope({ tasks: [task('a', 1, 'A'), task('b', 1, 'B')] }) };
    const desktop = { envelope: envelope({ tasks: [task('c', 2, 'C')] }) };

    syncDevice(phone, server, T(3));
    syncDevice(desktop, server, T(3));
    syncDevice(phone, server, T(4));
    const ids = (d: { envelope: SyncEnvelope }) => d.envelope.data.tasks.map((t) => t.id).sort();
    expect(ids(phone)).toEqual(['a', 'b', 'c']);
    expect(ids(desktop)).toEqual(['a', 'b', 'c']);

    // Phone renames a; desktop deletes b and, later, edits a too (desktop wins on a).
    phone.envelope.data.tasks = phone.envelope.data.tasks.map((t) => (t.id === 'a' ? { ...t, title: 'A phone', updatedAt: T(5) } : t));
    desktop.envelope.data.tasks = desktop.envelope.data.tasks
      .filter((t) => t.id !== 'b')
      .map((t) => (t.id === 'a' ? { ...t, title: 'A desktop', updatedAt: T(6) } : t));
    desktop.envelope.tombstones = { b: T(5) };

    syncDevice(phone, server, T(7));
    syncDevice(desktop, server, T(7));
    syncDevice(phone, server, T(8));

    for (const device of [phone, desktop]) {
      expect(ids(device)).toEqual(['a', 'c']);
      expect(device.envelope.data.tasks.find((t) => t.id === 'a')!.title).toBe('A desktop');
    }
    expect(server.rows.get('b')?.deleted).toBe(true);
    expect(server.rows.get('a')?.data).toMatchObject({ title: 'A desktop' });

    // Nothing left to send: a further round uploads nothing.
    expect(syncDevice(phone, server, T(9))).toEqual([]);
    expect(syncDevice(desktop, server, T(9))).toEqual([]);
  });

  it('a fresh install drops its sample day when the account has real tasks', () => {
    const server = new FakeServer();
    const phone = { envelope: envelope({ tasks: [task('real-1', 1)] }) };
    syncDevice(phone, server, T(2));

    const starter = ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'].map((id) => task(id, 3));
    const fresh = { envelope: envelope({ tasks: starter }) };
    const pushed = syncDevice(fresh, server, T(4));

    expect(pushed).toEqual([]);
    expect(fresh.envelope.data.tasks.map((t) => t.id)).toEqual(['real-1']);
    expect([...server.rows.keys()]).toEqual(['real-1']);
  });
});

describe('restoreFromRows', () => {
  it('replaces the device with the cloud copy and refuses an empty cloud', () => {
    const local = envelope({ tasks: [task('local-only', 9)] }, { tombstones: { x: T(1) }, deviceId: 'phone' });
    expect(restoreFromRows(local, { meta: [], rows: [] })).toBeNull();

    const meta: CloudRowMeta[] = [
      { id: 'cloud-1', collection: 'tasks', updated_at: T(2), deleted: false, server_updated_at: T(20) },
      { id: 'dead', collection: 'tasks', updated_at: T(3), deleted: true, server_updated_at: T(21) },
    ];
    const rows: CloudRow[] = [{ id: 'cloud-1', collection: 'tasks', data: task('cloud-1', 2) as never, updated_at: T(2), deleted: false }];
    const restored = restoreFromRows(local, { meta, rows })!;
    expect(restored.data.tasks.map((t) => t.id)).toEqual(['cloud-1']);
    expect(restored.tombstones).toEqual({ dead: T(3) });
    expect(restored.deviceId).toBe('phone');
  });
});

describe('sameSnapshot', () => {
  it('ignores tombstone key order', () => {
    const a = envelope({}, { tombstones: { x: T(1), y: T(2) } });
    const b = envelope({}, { tombstones: { y: T(2), x: T(1) } });
    expect(sameSnapshot(a, b)).toBe(true);
    expect(sameSnapshot(a, envelope())).toBe(false);
  });
});

describe('RECORD_COLLECTIONS', () => {
  it('lists exactly the collections a backup carries, so nothing is synced or backed up alone', async () => {
    const { BACKUP_ARRAY_KEYS } = await import('./backup');
    expect([...RECORD_COLLECTIONS].sort()).toEqual([...BACKUP_ARRAY_KEYS].sort());
  });
});

describe('initialSyncMode', () => {
  it('merges for the same account or a device never synced, switches for another account', () => {
    expect(initialSyncMode(undefined, 'user-a')).toBe('merge');
    expect(initialSyncMode('user-a', 'user-a')).toBe('merge');
    expect(initialSyncMode('user-a', 'user-b')).toBe('switch-account');
    expect(isAccountSwitch('user-a', 'user-b')).toBe(true);
    expect(isAccountSwitch(undefined, 'user-b')).toBe(false);
  });
});
