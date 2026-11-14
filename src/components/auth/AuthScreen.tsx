import React, { useEffect, useRef, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Eye, EyeOff, Loader2, LogIn, Mail, UserPlus } from 'lucide-react';
import { Button } from '../ui/Button';
import { cn } from '../../lib/cn';
import { isNative } from '../../lib/platform';
import { resetPassword, signIn, signUp } from '../../services/cloudSyncService';
import { AuthShell, authInputClass } from './AuthShell';

type Mode = 'signin' | 'signup' | 'reset';

export const MIN_PASSWORD_LENGTH = 8;

/** Full-screen Sign in / Create account / Forgot password. The app opens once a session exists. */
export const AuthScreen: React.FC = () => {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
  };

  // Android back: from Create account / Forgot password return to Sign in;
  // from Sign in leave the app in the background, as the app itself does.
  const passwordRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (!isNative()) return;
    let disposed = false;
    let remove: (() => void) | null = null;
    void CapApp.addListener('backButton', () => {
      if (modeRef.current !== 'signin') {
        setMode('signin');
        setError(null);
        setNotice(null);
      } else {
        void CapApp.minimizeApp();
      }
    }).then((handle) => {
      if (disposed) {
        void handle.remove();
        return;
      }
      remove = () => void handle.remove();
    });
    return () => {
      disposed = true;
      remove?.();
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!email.trim()) {
      setError('Enter your email address.');
      return;
    }
    if (mode !== 'reset' && !password) {
      setError('Enter your password.');
      return;
    }
    if (mode === 'signup' && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`);
      return;
    }
    setBusy(true);
    try {
      if (mode === 'signin') {
        // On success Supabase saves the session and the gate opens the app.
        await signIn(email, password);
      } else if (mode === 'signup') {
        const session = await signUp(email, password);
        if (!session) {
          setNotice('Account created. Open the confirmation link we emailed you, then sign in.');
          setMode('signin');
          setPassword('');
        }
      } else {
        await resetPassword(email);
        setNotice('If an account exists for that email, a reset link is on its way. Open it on this device to set a new password.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const title = mode === 'signin' ? 'Welcome back' : mode === 'signup' ? 'Create your account' : 'Reset your password';
  const subtitle =
    mode === 'signin'
      ? 'Sign in to open your tasks, money and diary.'
      : mode === 'signup'
        ? 'Anything already on this device is kept and uploaded to your new account.'
        : 'We’ll email you a link to choose a new password.';

  return (
    <AuthShell title={title} subtitle={subtitle}>
      {mode !== 'reset' && (
        <div className="flex gap-1 rounded-xl bg-slate-100 dark:bg-slate-800 p-1 text-sm font-semibold" role="tablist">
          {(['signin', 'signup'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => switchMode(value)}
              className={cn(
                'flex-1 rounded-lg py-2 transition-colors',
                mode === value
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
              )}
            >
              {value === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          ))}
        </div>
      )}

      <form className="space-y-3" onSubmit={(event) => void submit(event)} noValidate>
        <label className="block space-y-1">
          <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Email</span>
          <input
            type="email"
            autoComplete="email"
            inputMode="email"
            enterKeyHint={mode === 'reset' ? 'send' : 'next'}
            onKeyDown={(event) => {
              // Keyboard "Next" moves to the password instead of submitting early.
              if (event.key === 'Enter' && mode !== 'reset') {
                event.preventDefault();
                passwordRef.current?.focus();
              }
            }}
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={authInputClass}
            disabled={busy}
            placeholder="you@example.com"
          />
        </label>

        {mode !== 'reset' && (
          <label className="block space-y-1">
            <span className="flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300">
              <span>Password</span>
              {mode === 'signin' && (
                <button
                  type="button"
                  onClick={() => switchMode('reset')}
                  className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  Forgot password?
                </button>
              )}
            </span>
            <span className="relative block">
              <input
                ref={passwordRef}
                type={showPassword ? 'text' : 'password'}
                enterKeyHint="go"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={cn(authInputClass, 'pr-11')}
                disabled={busy}
                placeholder={mode === 'signup' ? `At least ${MIN_PASSWORD_LENGTH} characters` : ''}
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </span>
          </label>
        )}

        {error && (
          <p className="rounded-lg bg-rose-50 dark:bg-rose-950/50 px-3 py-2 text-xs text-rose-700 dark:text-rose-300" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-lg bg-emerald-50 dark:bg-emerald-950/50 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300" role="status">
            {notice}
          </p>
        )}

        <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : mode === 'signin' ? (
            <LogIn className="h-4 w-4" />
          ) : mode === 'signup' ? (
            <UserPlus className="h-4 w-4" />
          ) : (
            <Mail className="h-4 w-4" />
          )}
          <span>{mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}</span>
        </Button>
      </form>

      {mode === 'reset' && (
        <button
          type="button"
          onClick={() => switchMode('signin')}
          className="w-full text-center text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
        >
          Back to sign in
        </button>
      )}
    </AuthShell>
  );
};
