import { useState, type FormEvent } from 'react';
import { Fingerprint } from 'lucide-react';

interface AppLockScreenProps {
  theme: 'light' | 'dark';
  error: string;
  onUnlock: () => void;
  /**
   * Website only: unlock with the account password when the fingerprint
   * cannot be used. Resolves '' on success, or a message to show.
   */
  onUsePassword?: (password: string) => Promise<string>;
}

export function AppLockScreen({ theme, error, onUnlock, onUsePassword }: AppLockScreenProps) {
  const dark = theme === 'dark';
  const [showPassword, setShowPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [checking, setChecking] = useState(false);

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!onUsePassword || checking || !password) return;
    setChecking(true);
    setPasswordError('');
    const message = await onUsePassword(password);
    setChecking(false);
    if (message) setPasswordError(message);
    else setPassword('');
  };

  const muted = dark ? 'text-slate-400' : 'text-slate-500';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-lock-title"
      className={`fixed inset-0 z-[80] flex flex-col items-center justify-center px-6 ${
        dark ? 'bg-slate-950 text-slate-100' : 'bg-stone-50 text-slate-900'
      }`}
    >
      <div
        className={`mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border ${
          dark ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white'
        }`}
      >
        <Fingerprint className="h-8 w-8 text-indigo-500" />
      </div>
      <h1 id="app-lock-title" className="text-lg font-bold">
        Dayflow is locked
      </h1>
      <p className={`mt-1 max-w-xs text-center text-sm ${muted}`}>Use your fingerprint, face unlock, or PIN.</p>
      {error && <p className="mt-3 max-w-xs text-center text-sm text-rose-500">{error}</p>}
      <button
        type="button"
        onClick={onUnlock}
        className="mt-6 rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white"
      >
        Unlock
      </button>

      {onUsePassword && !showPassword && (
        <button
          type="button"
          onClick={() => setShowPassword(true)}
          className={`mt-4 text-xs font-semibold underline underline-offset-2 ${muted}`}
        >
          Fingerprint not working? Use your account password
        </button>
      )}
      {onUsePassword && showPassword && (
        <form onSubmit={(event) => void submitPassword(event)} className="mt-5 w-full max-w-xs space-y-2">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Account password"
            aria-label="Account password"
            autoFocus
            className={`w-full rounded-xl border px-3 py-2.5 text-sm ${
              dark ? 'border-slate-700 bg-slate-900 text-slate-100' : 'border-slate-300 bg-white text-slate-900'
            }`}
          />
          {passwordError && <p className="text-center text-xs text-rose-500">{passwordError}</p>}
          <button
            type="submit"
            disabled={checking || !password}
            className={`w-full rounded-xl border px-3 py-2.5 text-sm font-semibold disabled:opacity-50 ${
              dark ? 'border-slate-700 text-slate-200' : 'border-slate-300 text-slate-700'
            }`}
          >
            {checking ? 'Checking…' : 'Unlock with password'}
          </button>
        </form>
      )}
    </div>
  );
}
