import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, ExternalLink, Eye, EyeOff, History, Pencil, Star, Trash2, UserRound } from 'lucide-react';
import type { VaultEntry } from '../../lib/passwordVault';
import { formatShortDate } from '../../lib/dateFormat';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { cn } from '../../lib/cn';
import { CopyButton, ItemAvatar, KIND_LABEL, kindOf, openableUrl, StrengthBadge, TotpCode } from './VaultParts';

/** A revealed secret hides itself again after this long. */
const REVEAL_MS = 30_000;

interface Props {
  entry: VaultEntry;
  busy: boolean;
  reused: boolean;
  onBack: () => void;
  onEdit: () => void;
  onToggleFavorite: () => void;
  onTrash: () => void;
  onCopy: (text: string) => Promise<void>;
}

function Row({ label, children, actions }: { label: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 py-3 last:border-b-0 dark:border-slate-800">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">{label}</div>
        <div className="break-all text-sm">{children}</div>
      </div>
      {actions}
    </div>
  );
}

function shortDate(iso: string | undefined): string {
  if (!iso) return '';
  try {
    return formatShortDate(iso.slice(0, 10));
  } catch {
    return iso.slice(0, 10);
  }
}

function useReveal(): [string | undefined, (key: string | undefined) => void] {
  const [revealed, setRevealed] = useState<string>();
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => setRevealed(undefined), REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [revealed]);
  return [revealed, setRevealed];
}

export function VaultDetails({ entry, busy, reused, onBack, onEdit, onToggleFavorite, onTrash, onCopy }: Props) {
  const [revealed, setRevealed] = useReveal();
  const [showHistory, setShowHistory] = useState(false);
  const kind = kindOf(entry);
  const url = openableUrl(entry.website);

  const secret = (key: string, value: string, label: string, extra?: ReactNode) => (
    <Row
      label={<>{label}{extra}</>}
      actions={<>
        <button type="button" aria-label={revealed === key ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          onClick={() => setRevealed(revealed === key ? undefined : key)}
          className="flex size-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800">
          {revealed === key ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
        <CopyButton label={`Copy ${label.toLowerCase()}`} onCopy={() => onCopy(value)} />
      </>}
    >
      <span className={cn(revealed === key && 'font-mono')}>{revealed === key ? value : '•'.repeat(Math.min(Math.max(value.length, 8), 16))}</span>
    </Row>
  );

  return (
    <div className="space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="size-4" /> All items</Button>
      <Card className="p-4">
        <div className="flex items-start gap-3">
          <ItemAvatar entry={entry} size="lg" />
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-lg font-bold">{entry.title}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {KIND_LABEL[kind]}{entry.category ? ` · ${entry.category}` : ''}
              {entry.passwordChangedAt ? ` · password set ${shortDate(entry.passwordChangedAt)}` : ''}
            </p>
          </div>
          <button type="button" aria-pressed={Boolean(entry.favorite)} aria-label={entry.favorite ? 'Remove from favourites' : 'Add to favourites'}
            disabled={busy} onClick={onToggleFavorite}
            className="flex size-10 items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800">
            <Star className={cn('size-5', entry.favorite ? 'fill-amber-400 text-amber-500' : 'text-slate-400')} />
          </button>
        </div>

        <div className="mt-3">
          {(kind === 'login' || kind === 'wifi') && entry.username && (
            <Row label={kind === 'wifi' ? 'Network name' : 'Username'} actions={<CopyButton icon={UserRound} label="Copy username" onCopy={() => onCopy(entry.username)} />}>
              {entry.username}
            </Row>
          )}
          {(kind === 'login' || kind === 'wifi') && entry.password && secret('password', entry.password, 'Password', (
            <span className="ml-2 inline-flex gap-1">
              <StrengthBadge password={entry.password} />
              {reused && <span className="font-semibold text-amber-700 dark:text-amber-300">· reused</span>}
            </span>
          ))}
          {kind === 'login' && entry.totp && (
            <Row label="2FA code"><TotpCode secret={entry.totp} onCopy={onCopy} /></Row>
          )}
          {kind === 'login' && entry.website && (
            <Row label="Website" actions={url ? (
              <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open website"
                className="flex size-10 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800">
                <ExternalLink className="size-4" />
              </a>
            ) : undefined}>
              {entry.website}
            </Row>
          )}
          {kind === 'card' && entry.card && <>
            {entry.card.holder && <Row label="Name on card">{entry.card.holder}</Row>}
            {entry.card.number && secret('number', entry.card.number, 'Card number')}
            {entry.card.expiry && <Row label="Expiry" actions={<CopyButton label="Copy expiry" onCopy={() => onCopy(entry.card!.expiry)} />}>{entry.card.expiry}</Row>}
            {entry.card.cvv && secret('cvv', entry.card.cvv, 'CVV')}
            {entry.password && secret('pin', entry.password, 'PIN')}
          </>}
          {entry.notes && (
            <Row label={kind === 'note' ? 'Note' : 'Notes'} actions={kind === 'note' ? <CopyButton label="Copy note" onCopy={() => onCopy(entry.notes)} /> : undefined}>
              <span className="whitespace-pre-wrap break-words">{entry.notes}</span>
            </Row>
          )}
          {entry.history?.length ? (
            <div className="py-3">
              <button type="button" onClick={() => setShowHistory((value) => !value)}
                className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
                <History className="size-4" /> Password history ({entry.history.length})
              </button>
              {showHistory && (
                <ul className="mt-1 space-y-1">
                  {entry.history.map((item, index) => (
                    <li key={`${item.changedAt}-${index}`} className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-1 dark:bg-slate-900">
                      <span className="min-w-0 flex-1 text-sm">
                        <span className="font-mono">{revealed === `h${index}` ? item.password : '••••••••'}</span>
                        <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">replaced {shortDate(item.changedAt)}</span>
                      </span>
                      <button type="button" aria-label="Show old password" onClick={() => setRevealed(revealed === `h${index}` ? undefined : `h${index}`)}
                        className="flex size-9 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
                        <Eye className="size-4" />
                      </button>
                      <CopyButton label="Copy old password" onCopy={() => onCopy(item.password)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={busy} onClick={onEdit}><Pencil className="size-4" /> Edit</Button>
          <Button variant="danger" disabled={busy} onClick={onTrash}><Trash2 className="size-4" /> Move to trash</Button>
        </div>
      </Card>
    </div>
  );
}
