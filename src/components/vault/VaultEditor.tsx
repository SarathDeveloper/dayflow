import { useState } from 'react';
import type { FormEvent } from 'react';
import { Star } from 'lucide-react';
import { generateVaultPassword, needsPassword, VAULT_ITEM_KINDS } from '../../lib/passwordVault';
import type { VaultEntry, VaultItemKind } from '../../lib/passwordVault';
import { isValidTotp } from '../../lib/totp';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { cn } from '../../lib/cn';
import { inputClass, KIND_ICON, KIND_LABEL, kindOf, labelClass, StrengthMeter, SUGGESTED_CATEGORIES } from './VaultParts';

interface Props {
  entry: VaultEntry;
  categories: string[];
  isNew: boolean;
  busy: boolean;
  onChange: (entry: VaultEntry) => void;
  onSave: (event: FormEvent) => void;
  onCancel: () => void;
}

function Field({ label, value, onChange, maxLength, required, type = 'text', placeholder, inputMode }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  required?: boolean;
  type?: string;
  placeholder?: string;
  inputMode?: 'numeric' | 'text' | 'url' | 'email';
}) {
  return (
    <label className={labelClass}>
      <span>{label}</span>
      <input className={inputClass} type={type} required={required} maxLength={maxLength} placeholder={placeholder}
        inputMode={inputMode} spellCheck={false} autoCapitalize="none" autoComplete="off"
        value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function VaultEditor({ entry, categories, isNew, busy, onChange, onSave, onCancel }: Props) {
  const [showPassword, setShowPassword] = useState(false);
  const [length, setLength] = useState(20);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const kind = kindOf(entry);
  const set = (patch: Partial<VaultEntry>) => onChange({ ...entry, ...patch });
  const card = entry.card ?? { holder: '', number: '', expiry: '', cvv: '' };
  const categoryOptions = [...new Set([...SUGGESTED_CATEGORIES, ...categories])].sort();
  const totpInvalid = Boolean(entry.totp?.trim()) && !isValidTotp(entry.totp ?? '');

  const passwordField = (
    <div className="space-y-2">
      <label className={labelClass}>
        <span>Password</span>
        <input className={inputClass} type={showPassword ? 'text' : 'password'} required={needsPassword(kind)} maxLength={1024}
          spellCheck={false} autoCapitalize="none" autoComplete="new-password"
          value={entry.password} onChange={(event) => set({ password: event.target.value })} />
      </label>
      <StrengthMeter password={entry.password} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" type="button" onClick={() => setShowPassword((value) => !value)}>
          {showPassword ? 'Hide password' : 'Show password'}
        </Button>
        <details className="w-full rounded-xl border border-slate-300 p-3 dark:border-slate-700">
          <summary className="cursor-pointer text-sm font-semibold">Generate a password</summary>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">Length
              <input className={`${inputClass} !w-20`} type="number" min={8} max={64} value={length}
                onChange={(event) => setLength(Number(event.target.value))} />
            </label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={digits} onChange={(event) => setDigits(event.target.checked)} /> Digits</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={symbols} onChange={(event) => setSymbols(event.target.checked)} /> Symbols</label>
            <Button type="button" variant="secondary" size="sm" disabled={!Number.isInteger(length) || length < 8 || length > 64}
              onClick={() => {
                set({ password: generateVaultPassword(length, digits, symbols) });
                setShowPassword(true);
              }}>Generate</Button>
          </div>
        </details>
      </div>
    </div>
  );

  return (
    <Card className="p-4">
      <form className="space-y-4" onSubmit={onSave} autoComplete="off">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-bold">{isNew ? `New ${KIND_LABEL[kind].toLowerCase()}` : `Edit ${KIND_LABEL[kind].toLowerCase()}`}</h3>
          <button type="button" aria-pressed={Boolean(entry.favorite)} onClick={() => set({ favorite: !entry.favorite || undefined })}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">
            <Star className={cn('size-4', entry.favorite && 'fill-amber-400 text-amber-500')} /> Favourite
          </button>
        </div>

        {isNew && (
          <div role="radiogroup" aria-label="Item type" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {VAULT_ITEM_KINDS.map((option: VaultItemKind) => {
              const Icon = KIND_ICON[option];
              const active = option === kind;
              return (
                <button key={option} type="button" role="radio" aria-checked={active}
                  onClick={() => set({ kind: option === 'login' ? undefined : option })}
                  className={cn('flex min-h-11 items-center justify-center gap-2 rounded-xl border px-2 text-sm font-semibold',
                    active ? 'border-indigo-500 bg-indigo-50 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200'
                      : 'border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300')}>
                  <Icon className="size-4" /> {KIND_LABEL[option]}
                </button>
              );
            })}
          </div>
        )}

        <fieldset disabled={busy} className="space-y-3">
          <Field label="Title" value={entry.title} onChange={(title) => set({ title })} maxLength={200} required
            placeholder={kind === 'card' ? 'HDFC credit card' : kind === 'wifi' ? 'Home Wi-Fi' : kind === 'note' ? 'Recovery codes' : 'Gmail'} />

          {kind === 'login' && <>
            <Field label="Website" value={entry.website} onChange={(website) => set({ website })} maxLength={2048} inputMode="url" placeholder="accounts.google.com" />
            <Field label="Username or email" value={entry.username} onChange={(username) => set({ username })} maxLength={512} />
            {passwordField}
            <label className={labelClass}>
              <span>2FA secret (optional)</span>
              <input className={inputClass} maxLength={512} spellCheck={false} autoCapitalize="none" autoComplete="off"
                placeholder="Base32 key or otpauth:// link" value={entry.totp ?? ''}
                onChange={(event) => set({ totp: event.target.value || undefined })} />
              <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">
                From the site’s “set up authenticator app” step. Dayflow then shows the 6-digit codes.
              </span>
              {totpInvalid && <span className="block text-xs font-semibold text-rose-700 dark:text-rose-300">This 2FA secret is not valid.</span>}
            </label>
          </>}

          {kind === 'wifi' && <>
            <Field label="Network name (SSID)" value={entry.username} onChange={(username) => set({ username })} maxLength={512} />
            {passwordField}
          </>}

          {kind === 'card' && <>
            <Field label="Name on card" value={card.holder} onChange={(holder) => set({ card: { ...card, holder } })} maxLength={200} />
            <Field label="Card number" value={card.number} inputMode="numeric" maxLength={40}
              onChange={(number) => set({ card: { ...card, number: number.replace(/[^\d ]/g, '') } })} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Expiry (MM/YY)" value={card.expiry} maxLength={10} placeholder="08/29"
                onChange={(expiry) => set({ card: { ...card, expiry } })} />
              <Field label="CVV" value={card.cvv} type="password" inputMode="numeric" maxLength={8}
                onChange={(cvv) => set({ card: { ...card, cvv: cvv.replace(/\D/g, '') } })} />
            </div>
            <Field label="Card PIN (optional)" value={entry.password} type="password" inputMode="numeric" maxLength={16}
              onChange={(password) => set({ password })} />
          </>}

          <label className={labelClass}>
            <span>Category</span>
            <input className={inputClass} list="vault-categories" maxLength={40} placeholder="Banking, Work, Personal…"
              value={entry.category ?? ''} onChange={(event) => set({ category: event.target.value || undefined })} />
            <datalist id="vault-categories">
              {categoryOptions.map((category) => <option key={category} value={category} />)}
            </datalist>
          </label>

          <label className={labelClass}>
            <span>{kind === 'note' ? 'Note' : 'Notes'}</span>
            <textarea className={cn(inputClass, kind === 'note' ? 'min-h-40' : 'min-h-20')} maxLength={4000} spellCheck={false}
              autoCapitalize="none" required={kind === 'note'} value={entry.notes} onChange={(event) => set({ notes: event.target.value })} />
          </label>
        </fieldset>

        <div className="flex gap-2">
          <Button type="submit" disabled={busy || totpInvalid}>{busy ? 'Saving…' : 'Save'}</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
