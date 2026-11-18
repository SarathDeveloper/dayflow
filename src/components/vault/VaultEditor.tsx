import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Eye, EyeOff, Star, WandSparkles } from 'lucide-react';
import { generateVaultPassword, needsPassword, VAULT_ITEM_KINDS } from '../../lib/passwordVault';
import type { VaultEntry, VaultItemKind } from '../../lib/passwordVault';
import { isValidTotp } from '../../lib/totp';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { cn } from '../../lib/cn';
import { inputClass, KIND_ICON, KIND_LABEL, kindOf, labelClass, siteName, StrengthMeter, SUGGESTED_CATEGORIES } from './VaultParts';

interface Props {
  entry: VaultEntry;
  categories: string[];
  isNew: boolean;
  busy: boolean;
  onChange: (entry: VaultEntry) => void;
  onSave: (event: FormEvent) => void;
  onCancel: () => void;
}

function Field({ label, value, onChange, maxLength, required, type = 'text', placeholder, inputMode, autoFocus }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  required?: boolean;
  type?: string;
  placeholder?: string;
  inputMode?: 'numeric' | 'text' | 'url' | 'email';
  autoFocus?: boolean;
}) {
  return (
    <label className={labelClass}>
      <span>{label}</span>
      <input className={inputClass} type={type} required={required} maxLength={maxLength} placeholder={placeholder}
        inputMode={inputMode} spellCheck={false} autoCapitalize="none" autoComplete="off" autoFocus={autoFocus}
        value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

const iconButton = 'flex size-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white';

export function VaultEditor({ entry, categories, isNew, busy, onChange, onSave, onCancel }: Props) {
  const [showPassword, setShowPassword] = useState(false);
  const kind = kindOf(entry);
  const set = (patch: Partial<VaultEntry>) => onChange({ ...entry, ...patch });
  const card = entry.card ?? { holder: '', number: '', expiry: '', cvv: '' };
  const categoryOptions = [...new Set([...SUGGESTED_CATEGORIES, ...categories])].sort();
  const totpInvalid = Boolean(entry.totp?.trim()) && !isValidTotp(entry.totp ?? '');
  // Extras start open only when editing an item that already uses them.
  const [moreOpen] = useState(() => Boolean(entry.totp || entry.category
    || (kind === 'card' && (entry.password || card.holder))
    || ((kind === 'card' || kind === 'wifi') && entry.notes)
    || (kind === 'login' && !isNew && entry.title && entry.title !== siteName(entry.website))));

  const setWebsite = (website: string) => {
    // Keep the name following the site until the user gives it their own.
    const follows = !entry.title || entry.title === siteName(entry.website);
    set(follows ? { website, title: siteName(website) } : { website });
  };

  const passwordField = (
    <div className="space-y-2">
      <label className={labelClass}>
        <span>Password</span>
        <div className="relative">
          <input className={cn(inputClass, 'pr-20')} type={showPassword ? 'text' : 'password'} required={needsPassword(kind)} maxLength={1024}
            spellCheck={false} autoCapitalize="none" autoComplete="new-password"
            value={entry.password} onChange={(event) => set({ password: event.target.value })} />
          <div className="absolute inset-y-0 right-1 flex items-center">
            <button type="button" className={iconButton} aria-label="Generate a strong password" title="Generate a strong password"
              onClick={() => {
                set({ password: generateVaultPassword(20, true, true) });
                setShowPassword(true);
              }}>
              <WandSparkles className="size-4" />
            </button>
            <button type="button" className={iconButton} aria-label={showPassword ? 'Hide password' : 'Show password'}
              title={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((value) => !value)}>
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>
      </label>
      <StrengthMeter password={entry.password} />
    </div>
  );

  const titleField = (
    <Field label={kind === 'login' ? 'Name' : 'Title'} value={entry.title} onChange={(title) => set({ title })} maxLength={200}
      required={kind !== 'login'} autoFocus={isNew && kind !== 'login'}
      placeholder={kind === 'card' ? 'HDFC credit card' : kind === 'wifi' ? 'Home Wi-Fi' : kind === 'note' ? 'Recovery codes' : 'Defaults to the site'} />
  );

  const categoryField = (
    <label className={labelClass}>
      <span>Category</span>
      <input className={inputClass} list="vault-categories" maxLength={40} placeholder="Banking, Work, Personal…"
        value={entry.category ?? ''} onChange={(event) => set({ category: event.target.value || undefined })} />
      <datalist id="vault-categories">
        {categoryOptions.map((category) => <option key={category} value={category} />)}
      </datalist>
    </label>
  );

  const notesField = (
    <label className={labelClass}>
      <span>Note</span>
      <textarea className={cn(inputClass, kind === 'note' ? 'min-h-40' : 'min-h-16')} maxLength={4000} spellCheck={false}
        autoCapitalize="none" required={kind === 'note'} value={entry.notes} onChange={(event) => set({ notes: event.target.value })} />
    </label>
  );

  const more = (children: ReactNode) => (
    <details open={moreOpen || totpInvalid} className="group">
      <summary className="cursor-pointer list-none text-sm font-semibold text-indigo-700 dark:text-indigo-300 [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">More options</span>
        <span className="hidden group-open:inline">Fewer options</span>
      </summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );

  return (
    <Card className="p-4 sm:p-5">
      <form className="space-y-4" onSubmit={onSave} autoComplete="off">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-lg font-bold">{isNew ? 'Add to vault' : `Edit ${KIND_LABEL[kind].toLowerCase()}`}</h3>
          <button type="button" aria-pressed={Boolean(entry.favorite)} aria-label="Favourite" title="Favourite"
            onClick={() => set({ favorite: !entry.favorite || undefined })} className={iconButton}>
            <Star className={cn('size-5', entry.favorite && 'fill-amber-400 text-amber-500')} />
          </button>
        </div>

        {isNew && (
          <div role="radiogroup" aria-label="Item type" className="flex gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800/60">
            {VAULT_ITEM_KINDS.map((option: VaultItemKind) => {
              const Icon = KIND_ICON[option];
              const active = option === kind;
              return (
                <button key={option} type="button" role="radio" aria-checked={active}
                  onClick={() => set({ kind: option === 'login' ? undefined : option })}
                  className={cn('flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-semibold transition-colors',
                    active ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-white'
                      : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')}>
                  <Icon className="size-4 shrink-0" /> <span className="truncate">{option === 'note' ? 'Note' : KIND_LABEL[option]}</span>
                </button>
              );
            })}
          </div>
        )}

        <fieldset disabled={busy} className="space-y-3">
          {kind === 'login' && <>
            <Field label="Site" value={entry.website} onChange={setWebsite} maxLength={2048} inputMode="url"
              placeholder="accounts.google.com" autoFocus={isNew} />
            <Field label="Username" value={entry.username} onChange={(username) => set({ username })} maxLength={512} />
            {passwordField}
            {notesField}
            {more(<>
              {titleField}
              <label className={labelClass}>
                <span>2FA secret</span>
                <input className={inputClass} maxLength={512} spellCheck={false} autoCapitalize="none" autoComplete="off"
                  placeholder="Setup key or otpauth:// link" value={entry.totp ?? ''}
                  onChange={(event) => set({ totp: event.target.value || undefined })} />
                {totpInvalid && <span className="block text-xs font-semibold text-rose-700 dark:text-rose-300">This 2FA secret is not valid.</span>}
              </label>
              {categoryField}
            </>)}
          </>}

          {kind === 'wifi' && <>
            {titleField}
            <Field label="Network name" value={entry.username} onChange={(username) => set({ username })} maxLength={512} />
            {passwordField}
            {more(<>{notesField}{categoryField}</>)}
          </>}

          {kind === 'card' && <>
            {titleField}
            <Field label="Card number" value={card.number} inputMode="numeric" maxLength={40}
              onChange={(number) => set({ card: { ...card, number: number.replace(/[^\d ]/g, '') } })} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Expiry" value={card.expiry} maxLength={10} placeholder="MM/YY"
                onChange={(expiry) => set({ card: { ...card, expiry } })} />
              <Field label="CVV" value={card.cvv} type="password" inputMode="numeric" maxLength={8}
                onChange={(cvv) => set({ card: { ...card, cvv: cvv.replace(/\D/g, '') } })} />
            </div>
            {more(<>
              <Field label="Name on card" value={card.holder} onChange={(holder) => set({ card: { ...card, holder } })} maxLength={200} />
              <Field label="Card PIN" value={entry.password} type="password" inputMode="numeric" maxLength={16}
                onChange={(password) => set({ password })} />
              {notesField}
              {categoryField}
            </>)}
          </>}

          {kind === 'note' && <>
            {titleField}
            {notesField}
            {more(categoryField)}
          </>}
        </fieldset>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={busy || totpInvalid}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </Card>
  );
}
