import React, { useMemo, useRef, useState } from 'react';
import { FileUp, X } from 'lucide-react';
import type { Account, FinanceTransaction } from '../../types';
import {
  detectColumns,
  findDuplicates,
  parseCsv,
  readStatementRows,
  suggestCategory,
  type StatementRow,
} from '../../lib/statementCsv';
import { formatRupees } from '../../lib/money';
import { beginExternalActivity, endExternalActivity } from '../../lib/externalActivity';
import { Button } from '../ui/Button';

export interface ImportRow {
  date: string;
  description: string;
  type: 'income' | 'expense';
  amount: number;
  category: string;
}

interface Props {
  isOpen: boolean;
  accounts: Account[];
  transactions: FinanceTransaction[];
  categories: { income: string[]; expense: string[] };
  defaultAccountId?: string;
  onClose: () => void;
  onImport: (accountId: string, rows: ImportRow[]) => void;
}

interface Draft extends StatementRow {
  duplicate: boolean;
  include: boolean;
  category: string;
}

const field =
  'w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500';

/** Bank statement CSV in: pick the account and file, review the rows, import the ticked ones. */
export function StatementImportModal({ isOpen, accounts, transactions, categories, defaultAccountId, onClose, onImport }: Props) {
  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts[0]?.id ?? '');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<Draft[]>([]);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const chosen = useMemo(() => rows.filter((row) => row.include), [rows]);

  if (!isOpen) return null;

  const reset = () => {
    setFileName('');
    setRows([]);
    setError('');
  };

  const readFile = async (file: File | undefined) => {
    endExternalActivity();
    if (!file) return;
    setError('');
    setFileName(file.name);
    if (file.size > 5 * 1024 * 1024) {
      setRows([]);
      setError('That file is larger than 5 MB. Export a shorter period from your bank.');
      return;
    }
    const csv = parseCsv(await file.text());
    const detected = detectColumns(csv);
    if (!detected) {
      setRows([]);
      setError('No date and amount columns found. Download the statement as CSV and try again.');
      return;
    }
    const read = readStatementRows(csv, detected.headerRow, detected.columns);
    if (read.length === 0) {
      setRows([]);
      setError('No entries found in that file.');
      return;
    }
    const dups = findDuplicates(read, transactions, accountId);
    setRows(
      read.map((row) => ({
        ...row,
        duplicate: dups.has(row.line),
        include: !dups.has(row.line),
        category: suggestCategory(row, transactions, categories),
      }))
    );
  };

  const changeAccount = (id: string) => {
    setAccountId(id);
    // Duplicates depend on the account: check again.
    setRows((current) => {
      const dups = findDuplicates(current, transactions, id);
      return current.map((row) => ({ ...row, duplicate: dups.has(row.line), include: !dups.has(row.line) }));
    });
  };

  const patch = (line: number, change: Partial<Draft>) =>
    setRows((current) => current.map((row) => (row.line === line ? { ...row, ...change } : row)));

  const totalOut = chosen.filter((r) => r.type === 'expense').reduce((sum, r) => sum + Math.round(r.amount * 100), 0) / 100;
  const totalIn = chosen.filter((r) => r.type === 'income').reduce((sum, r) => sum + Math.round(r.amount * 100), 0) / 100;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center bg-slate-950/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h2 id="import-title" className="text-lg font-bold">Import bank statement</h2>
          <button type="button" onClick={() => { reset(); onClose(); }} aria-label="Close" className="w-9 h-9 flex items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto text-sm flex-1">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Into account
              <select value={accountId} onChange={(e) => changeAccount(e.target.value)} className={`${field} mt-1`}>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.name}</option>
                ))}
              </select>
            </label>
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Statement (CSV)
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  void readFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <Button
                type="button"
                variant="secondary"
                className="w-full mt-1 justify-center"
                onClick={() => {
                  beginExternalActivity();
                  fileRef.current?.click();
                }}
              >
                <FileUp className="w-4 h-4" />
                <span className="truncate">{fileName || 'Choose file'}</span>
              </Button>
            </div>
          </div>

          {error && <p role="alert" className="rounded-xl bg-rose-50 dark:bg-rose-950 px-3 py-2 text-xs text-rose-700 dark:text-rose-200">{error}</p>}

          {rows.length === 0 && !error && (
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Download the statement from your bank as CSV, then choose it here.
            </p>
          )}

          {rows.length > 0 && (
            <>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {rows.length} rows · {rows.filter((r) => r.duplicate).length} already in the ledger (unticked).
              </p>
              <ul className="space-y-1.5">
                {rows.map((row) => (
                  <li
                    key={row.line}
                    className={`rounded-xl border px-2.5 py-2 ${row.include ? 'border-slate-200 dark:border-slate-700' : 'border-dashed border-slate-200 dark:border-slate-800 opacity-60'}`}
                  >
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={row.include}
                        onChange={(e) => patch(row.line, { include: e.target.checked })}
                        className="mt-1 w-4 h-4 accent-indigo-600"
                      />
                      <span className="flex-1 min-w-0">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="text-xs font-semibold truncate">{row.description || 'No description'}</span>
                          <span className={`text-xs font-black shrink-0 ${row.type === 'income' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                            {row.type === 'income' ? '+' : '−'}
                            {formatRupees(row.amount)}
                          </span>
                        </span>
                        <span className="block text-[10px] text-slate-500 dark:text-slate-400">
                          {row.date}
                          {row.duplicate ? ' · already in the ledger' : ''}
                        </span>
                      </span>
                    </label>
                    {row.include && (
                      <select
                        aria-label="Category"
                        value={row.category}
                        onChange={(e) => patch(row.line, { category: e.target.value })}
                        className={`${field} mt-1.5 py-1.5 text-xs`}
                      >
                        {(row.type === 'income' ? categories.income : categories.expense).map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={() => { reset(); onClose(); }}>
            Cancel
          </Button>
          <Button
            type="button"
            className="flex-1"
            disabled={chosen.length === 0 || !accountId}
            onClick={() => {
              onImport(
                accountId,
                chosen.map(({ date, description, type, amount, category }) => ({ date, description, type, amount, category }))
              );
              reset();
              onClose();
            }}
          >
            Import {chosen.length || ''}
          </Button>
        </div>
        {chosen.length > 0 && (
          <p className="px-5 pb-3 -mt-1 text-[10px] text-slate-500 dark:text-slate-400">
            In {formatRupees(totalIn)} · Out {formatRupees(totalOut)}
          </p>
        )}
      </div>
    </div>
  );
}
