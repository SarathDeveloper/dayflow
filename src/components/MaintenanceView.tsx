import { useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Download, FileLock2, Paperclip, Pencil, Plus, Trash2, Upload, Wrench } from 'lucide-react';
import type { FinanceTransaction, MaintenanceItem, MaintenanceKind, MaintenanceServiceRecord } from '../types';
import {
  DEFAULT_MAINTENANCE_REMINDER_DAYS, MAINTENANCE_LIMITS, linkableTransactions, maintenanceExportFilename,
  maintenanceSpend, maintenanceStatus, serializeMaintenanceExport, parseMaintenanceExport, serviceCost,
} from '../lib/maintenance';
import { todayString } from '../lib/ledger';
import { formatRupees, parseAmountInput, isAmountParseError } from '../lib/money';
import { formatShortDate } from '../lib/dateFormat';
import { downloadTextFile, readDamagedMaintenance } from '../services/maintenanceStorage';
import { exportTextNative, hasDocumentVaultNative } from '../services/documentVaultNative';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { showConfirm } from './ui/AppDialog';

export interface MaintenanceDocumentIntent {
  assetId?: string;
  serviceRecordId?: string;
  action: 'view' | 'add';
}

export interface ItemDraft {
  asset: string;
  kind: MaintenanceKind;
  title: string;
  due: string;
  intervalMonths: number;
  reminderDays: number[];
}

export interface ServiceDraft {
  date: string;
  notes: string;
  cost?: number;
  transactionId?: string;
}

interface MaintenanceViewProps {
  items: MaintenanceItem[];
  transactions: FinanceTransaction[];
  /** Null when reminders notify on this device; otherwise why they only show on Today. */
  reminderNote: string | null;
  storageError: string | null;
  damagedNotice: string | null;
  damagedKey: string | null;
  /** Each handler throws a user-facing Error when the change is refused. */
  onCreate: (draft: ItemDraft) => void;
  onUpdate: (id: string, draft: ItemDraft) => void;
  onDelete: (id: string) => void;
  onRecordService: (id: string, service: ServiceDraft) => void;
  onUpdateService: (id: string, recordId: string, service: ServiceDraft) => void;
  onDeleteService: (id: string, recordId: string) => void;
  onImport: (items: MaintenanceItem[]) => number;
  onOpenDocuments: (intent: MaintenanceDocumentIntent) => void;
}

const inputClass = 'w-full min-h-11 rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-white';
const labelClass = 'block space-y-1 text-sm font-semibold text-slate-700 dark:text-slate-200';

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function parseReminderDays(text: string): number[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const values = trimmed.split(/[\s,]+/).map((part) => Number(part));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > MAINTENANCE_LIMITS.maxReminderDay)) {
    throw new Error(`Reminder days must be whole numbers from 0 to ${MAINTENANCE_LIMITS.maxReminderDay}, separated by commas.`);
  }
  return values;
}

function txLabel(tx: FinanceTransaction): string {
  return `${formatShortDate(tx.date)} · ${formatRupees(tx.amount)} · ${tx.note?.trim() || tx.category}`;
}

async function saveText(text: string, filename: string): Promise<boolean> {
  if (hasDocumentVaultNative()) return exportTextNative(text, filename, 'application/json');
  downloadTextFile(text, filename);
  return true;
}

export default function MaintenanceView(props: MaintenanceViewProps) {
  const { items, transactions, reminderNote, storageError, damagedNotice, damagedKey } = props;
  const today = todayString();
  const [editing, setEditing] = useState<{ id: string | null; draft: ItemDraft; reminderText: string } | null>(null);
  const [serviceForm, setServiceForm] = useState<{ itemId: string; recordId: string | null; date: string; notes: string; mode: 'none' | 'cost' | 'link'; cost: string; transactionId: string } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const importRef = useRef<HTMLInputElement>(null);

  const sorted = useMemo(() => [...items].sort((a, b) => a.due.localeCompare(b.due) || a.asset.localeCompare(b.asset)), [items]);

  const run = (action: () => void | Promise<void>, success?: string) => {
    setError('');
    setNotice('');
    try {
      const result = action();
      if (result instanceof Promise) {
        void result.then(() => success && setNotice(success)).catch((cause) => setError(message(cause, 'That did not work. Try again.')));
      } else if (success) {
        setNotice(success);
      }
    } catch (cause) {
      setError(message(cause, 'That did not work. Try again.'));
    }
  };

  const startNew = () => {
    setServiceForm(null);
    setEditing({
      id: null,
      draft: { asset: '', kind: 'vehicle', title: '', due: today, intervalMonths: 6, reminderDays: DEFAULT_MAINTENANCE_REMINDER_DAYS },
      reminderText: DEFAULT_MAINTENANCE_REMINDER_DAYS.join(', '),
    });
  };

  const startEdit = (item: MaintenanceItem) => {
    setServiceForm(null);
    setEditing({
      id: item.id,
      draft: { asset: item.asset, kind: item.kind, title: item.title, due: item.due, intervalMonths: item.intervalMonths, reminderDays: item.reminderDays },
      reminderText: item.reminderDays.join(', '),
    });
  };

  const submitItem = (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    run(() => {
      const draft = { ...editing.draft, reminderDays: parseReminderDays(editing.reminderText) };
      if (editing.id) props.onUpdate(editing.id, draft);
      else props.onCreate(draft);
      setEditing(null);
    }, editing.id ? 'Maintenance item updated.' : 'Maintenance item added.');
  };

  const deleteItem = async (item: MaintenanceItem) => {
    const ok = await showConfirm({
      title: 'Delete maintenance item?',
      message: `"${item.asset} · ${item.title}" and its ${item.history.length} service ${item.history.length === 1 ? 'record' : 'records'} will be deleted, and its reminders cancelled. Linked Money expenses stay in Money.`,
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (ok) run(() => props.onDelete(item.id), 'Maintenance item deleted.');
  };

  const startService = (item: MaintenanceItem, record?: MaintenanceServiceRecord) => {
    setEditing(null);
    setServiceForm({
      itemId: item.id,
      recordId: record?.id ?? null,
      date: record?.date ?? today,
      notes: record?.notes ?? '',
      mode: record?.transactionId ? 'link' : record?.cost !== undefined ? 'cost' : 'none',
      cost: record?.cost !== undefined ? String(record.cost) : '',
      transactionId: record?.transactionId ?? '',
    });
  };

  const submitService = (event: FormEvent) => {
    event.preventDefault();
    if (!serviceForm) return;
    run(() => {
      const service: ServiceDraft = { date: serviceForm.date, notes: serviceForm.notes };
      if (serviceForm.mode === 'cost') {
        const parsed = parseAmountInput(serviceForm.cost);
        if (isAmountParseError(parsed)) throw new Error('Enter the amount paid, for example 1499.50.');
        service.cost = parsed.rupees;
      } else if (serviceForm.mode === 'link') {
        if (!serviceForm.transactionId) throw new Error('Choose the Money expense that paid for this service.');
        service.transactionId = serviceForm.transactionId;
      }
      if (serviceForm.recordId) props.onUpdateService(serviceForm.itemId, serviceForm.recordId, service);
      else props.onRecordService(serviceForm.itemId, service);
      setServiceForm(null);
    }, serviceForm.recordId ? 'Service record updated.' : 'Service recorded. The next due date moved forward.');
  };

  const deleteService = async (item: MaintenanceItem, record: MaintenanceServiceRecord) => {
    const ok = await showConfirm({
      title: 'Delete service record?',
      message: `The ${formatShortDate(record.date)} service will be removed from the history. The next due date is not changed. A linked Money expense stays in Money.`,
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (ok) run(() => props.onDeleteService(item.id, record.id), 'Service record deleted.');
  };

  const exportAll = () => run(async () => {
    const saved = await saveText(serializeMaintenanceExport(items, new Date().toISOString()), maintenanceExportFilename());
    if (!saved) throw new Error('Export cancelled.');
  }, 'Maintenance records exported.');

  const importFile = async (file: File) => {
    setError('');
    setNotice('');
    try {
      if (file.size > MAINTENANCE_LIMITS.maxImportChars) throw new Error('That file is too large to be a maintenance export.');
      const incoming = parseMaintenanceExport(await file.text());
      const changed = props.onImport(incoming);
      setNotice(`Imported ${incoming.length} ${incoming.length === 1 ? 'item' : 'items'} (${changed} new or newer).`);
    } catch (cause) {
      setError(message(cause, 'Could not import that file.'));
    }
  };

  const downloadDamaged = () => {
    if (!damagedKey) return;
    const raw = readDamagedMaintenance(damagedKey);
    if (raw === null) {
      setError('The damaged copy is no longer on this device.');
      return;
    }
    run(async () => {
      const saved = await saveText(raw, `dayflow-maintenance-damaged-${today}.json`);
      if (!saved) throw new Error('Download cancelled.');
    }, 'Damaged data saved.');
  };

  return (
    <section className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-white"><Wrench className="size-5 text-indigo-600 dark:text-indigo-400" /> Vehicle &amp; Home</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">Services, filters and other upkeep, with reminders.</p>
        </div>
        <Button size="sm" className="shrink-0 whitespace-nowrap" onClick={startNew}><Plus className="size-4" /> Add</Button>
      </div>

      {storageError && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100">{storageError}</p>}
      {damagedNotice && (
        <div role="alert" className="space-y-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p>{damagedNotice}</p>
          {damagedKey && <Button size="sm" variant="secondary" onClick={downloadDamaged}><Download className="size-4" /> Download damaged copy</Button>}
        </div>
      )}
      {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100">{error}</p>}
      {notice && <p role="status" className="rounded-xl bg-indigo-50 p-3 text-sm text-indigo-800 dark:bg-indigo-950 dark:text-indigo-100">{notice}</p>}
      {reminderNote && <p className="text-xs text-slate-500 dark:text-slate-400">{reminderNote}</p>}

      {editing && (
        <Card className="p-4">
          <form className="space-y-3" onSubmit={submitItem}>
            <h3 className="font-bold text-slate-900 dark:text-white">{editing.id ? 'Edit maintenance' : 'New maintenance'}</h3>
            <label className={labelClass}><span>Type</span>
              <select className={inputClass} value={editing.draft.kind} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, kind: e.target.value as MaintenanceKind } })}>
                <option value="vehicle">Vehicle</option><option value="home">Home</option>
              </select>
            </label>
            <label className={labelClass}><span>Vehicle or appliance</span>
              <input required maxLength={MAINTENANCE_LIMITS.maxAsset} className={inputClass} placeholder="Honda City" value={editing.draft.asset}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, asset: e.target.value } })} />
            </label>
            <label className={labelClass}><span>Maintenance task</span>
              <input required maxLength={MAINTENANCE_LIMITS.maxTitle} className={inputClass} placeholder="Engine oil change" value={editing.draft.title}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, title: e.target.value } })} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className={labelClass}><span>Next due date</span>
                <input required type="date" className={inputClass} value={editing.draft.due}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, due: e.target.value } })} />
              </label>
              <label className={labelClass}><span>Repeat every (months)</span>
                <input required type="number" min={MAINTENANCE_LIMITS.minIntervalMonths} max={MAINTENANCE_LIMITS.maxIntervalMonths} className={inputClass}
                  value={Number.isFinite(editing.draft.intervalMonths) ? editing.draft.intervalMonths : ''}
                  onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, intervalMonths: Number(e.target.value) } })} />
              </label>
            </div>
            <label className={labelClass}><span>Remind me (days before; 0 = on the due date)</span>
              <input className={inputClass} inputMode="numeric" placeholder="3, 0" value={editing.reminderText}
                onChange={(e) => setEditing({ ...editing, reminderText: e.target.value })} />
              <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">Leave empty for no reminders. Up to {MAINTENANCE_LIMITS.maxReminders} values. Reminders fire at 9:00.</span>
            </label>
            <div className="flex gap-2"><Button type="submit">Save</Button><Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
          </form>
        </Card>
      )}

      {items.length === 0 && !editing && (
        <Card className="p-8 text-center space-y-2">
          <Wrench className="w-8 h-8 mx-auto text-indigo-500" />
          <p className="text-sm font-bold text-slate-800 dark:text-slate-100">No maintenance yet</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs mx-auto">
            Add a vehicle service, filter change or any other recurring task. Dayflow reminds you before it's due and keeps the service history.
          </p>
          <div className="pt-2">
            <Button size="sm" onClick={startNew}><Plus className="size-4" /> Add maintenance</Button>
          </div>
        </Card>
      )}

      {sorted.map((item) => {
        const status = maintenanceStatus(item, today);
        const spend = maintenanceSpend(item, transactions);
        const isServicing = serviceForm?.itemId === item.id;
        const linkable = isServicing ? linkableTransactions(items, transactions, serviceForm?.recordId ?? undefined) : [];
        return (
          <Card key={item.id} className="space-y-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="font-bold text-slate-900 dark:text-white break-words">{item.asset} · {item.title}</h3>
                <p className={`text-sm ${status === 'overdue' ? 'text-rose-600 dark:text-rose-400' : status === 'due-soon' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
                  {status === 'overdue' ? 'Overdue since' : 'Due'} {formatShortDate(item.due)} · every {item.intervalMonths} {item.intervalMonths === 1 ? 'month' : 'months'}
                  {item.kind === 'home' ? ' · Home' : ' · Vehicle'}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {item.reminderDays.length ? `Reminders: ${item.reminderDays.map((d) => (d === 0 ? 'on the day' : `${d}d before`)).join(', ')}` : 'No reminders'}
                  {spend > 0 && ` · Spent ${formatRupees(spend)}`}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="sm" variant="ghost" aria-label={`Edit ${item.asset} ${item.title}`} onClick={() => startEdit(item)}><Pencil className="size-4" /></Button>
                <Button size="sm" variant="danger" aria-label={`Delete ${item.asset} ${item.title}`} onClick={() => void deleteItem(item)}><Trash2 className="size-4" /></Button>
              </div>
            </div>

            {isServicing && serviceForm ? (
              <form className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-slate-700" onSubmit={submitService}>
                <h4 className="text-sm font-bold text-slate-900 dark:text-white">{serviceForm.recordId ? 'Edit service record' : 'Record service'}</h4>
                <label className={labelClass}><span>Completed on</span>
                  <input required type="date" max={today} className={inputClass} value={serviceForm.date} onChange={(e) => setServiceForm({ ...serviceForm, date: e.target.value })} />
                </label>
                <label className={labelClass}><span>Service notes</span>
                  <textarea maxLength={MAINTENANCE_LIMITS.maxNotes} className={inputClass} value={serviceForm.notes} onChange={(e) => setServiceForm({ ...serviceForm, notes: e.target.value })} />
                </label>
                <fieldset className="space-y-2 text-sm">
                  <legend className="font-semibold text-slate-700 dark:text-slate-200">Cost</legend>
                  {([['none', 'Not recorded'], ['cost', 'Enter amount (not in Money)'], ['link', 'Link an expense already in Money']] as const).map(([mode, label]) => (
                    <label key={mode} className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
                      <input type="radio" name={`cost-${item.id}`} checked={serviceForm.mode === mode} onChange={() => setServiceForm({ ...serviceForm, mode })} /> {label}
                    </label>
                  ))}
                  {serviceForm.mode === 'cost' && (
                    <input className={inputClass} inputMode="decimal" placeholder="Amount in ₹" value={serviceForm.cost} onChange={(e) => setServiceForm({ ...serviceForm, cost: e.target.value })} />
                  )}
                  {serviceForm.mode === 'link' && (linkable.length === 0 ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">No unlinked expenses in Money. Add the expense in Money first, or enter the amount here instead.</p>
                  ) : (
                    <select className={inputClass} value={serviceForm.transactionId} onChange={(e) => setServiceForm({ ...serviceForm, transactionId: e.target.value })}>
                      <option value="">Choose an expense…</option>
                      {linkable.slice(0, 200).map((tx) => <option key={tx.id} value={tx.id}>{txLabel(tx)}</option>)}
                    </select>
                  ))}
                  <p className="text-xs text-slate-500 dark:text-slate-400">A linked expense is counted once: Money keeps it, and this record shows its amount. An entered amount is not added to Money.</p>
                </fieldset>
                <div className="flex gap-2"><Button type="submit">{serviceForm.recordId ? 'Save record' : 'Record service'}</Button><Button type="button" variant="ghost" onClick={() => setServiceForm(null)}>Cancel</Button></div>
              </form>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => startService(item)}>Mark serviced</Button>
                <Button size="sm" variant="ghost" onClick={() => props.onOpenDocuments({ assetId: item.id, action: 'view' })}><FileLock2 className="size-4" /> Documents</Button>
              </div>
            )}

            {item.history.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm font-semibold text-slate-700 dark:text-slate-200">Service history ({item.history.length})</summary>
                <ul className="mt-2 space-y-2">
                  {[...item.history].sort((a, b) => b.date.localeCompare(a.date)).map((record) => {
                    const cost = serviceCost(record, transactions);
                    const linkedMissing = record.transactionId && !transactions.some((tx) => tx.id === record.transactionId);
                    return (
                      <li key={record.id} className="rounded-lg bg-slate-50 p-2 text-sm dark:bg-slate-800/60">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-slate-800 dark:text-slate-100">
                            {formatShortDate(record.date)}
                            {cost > 0 && <span className="font-normal text-slate-500 dark:text-slate-400"> · {formatRupees(cost)}{record.transactionId ? ' (in Money)' : ''}</span>}
                            {linkedMissing && <span className="font-normal text-amber-600 dark:text-amber-400"> · linked expense was deleted</span>}
                          </span>
                          <span className="flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => props.onOpenDocuments({ assetId: item.id, serviceRecordId: record.id, action: 'add' })}><Paperclip className="size-4" /> Receipt</Button>
                            <Button size="sm" variant="ghost" aria-label="Edit service record" onClick={() => startService(item, record)}><Pencil className="size-4" /></Button>
                            <Button size="sm" variant="ghost" aria-label="Delete service record" onClick={() => void deleteService(item, record)}><Trash2 className="size-4" /></Button>
                          </span>
                        </div>
                        {record.notes && <p className="mt-1 whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300">{record.notes}</p>}
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
          </Card>
        );
      })}

      <Card className="space-y-2 p-4">
        <h3 className="text-sm font-bold text-slate-900 dark:text-white">Export &amp; restore</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">Maintenance records sync with your account and are included in the full backup in Settings. You can also export just these records and import them on another device; newer edits win.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={items.length === 0} onClick={exportAll}><Download className="size-4" /> Export JSON</Button>
          <Button size="sm" variant="secondary" onClick={() => importRef.current?.click()}><Upload className="size-4" /> Import JSON</Button>
          <input ref={importRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) void importFile(file);
          }} />
        </div>
      </Card>
    </section>
  );
}
