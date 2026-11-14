import React, { useEffect, useRef, useState } from 'react';
import { ArrowRightLeft, KeyRound, Loader2, LogOut } from 'lucide-react';
import { Button } from '../ui/Button';
import { useAuthGate } from '../../hooks/useAuthGate';
import { updatePassword } from '../../services/cloudSyncService';
import { AuthScreen, MIN_PASSWORD_LENGTH } from './AuthScreen';
import { AuthShell, authInputClass } from './AuthShell';

interface AuthGateProps {
  /** Renders the app. `justSignedIn` is true when the person typed their password moments ago. */
  children: (props: { justSignedIn: boolean }) => React.ReactNode;
}

/** Login is required: nothing of the app renders until a session exists. */
export const AuthGate: React.FC<AuthGateProps> = ({ children }) => {
  const gate = useAuthGate();
  // Was a pre-app screen shown in this run? Then the app opens straight after
  // an interactive sign-in, and asking for the app-lock fingerprint as well
  // would be a second prompt for the same person.
  const sawGate = useRef(false);
  if (gate.view !== 'app') sawGate.current = true;

  if (gate.view === 'signed-out') return <AuthScreen />;
  if (gate.view === 'loading') {
    return (
      <AuthShell title="Opening your reset link…">
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-indigo-600" />
      </AuthShell>
    );
  }
  if (gate.view === 'confirm-switch') {
    return <ConfirmSwitchScreen email={gate.account?.email ?? ''} onReplace={gate.approveSwitch} onCancel={gate.cancel} />;
  }
  if (gate.view === 'set-password') {
    return <SetPasswordScreen onDone={gate.finishPasswordReset} onCancel={gate.cancel} />;
  }
  return <>{children({ justSignedIn: sawGate.current })}</>;
};

const ConfirmSwitchScreen: React.FC<{
  email: string;
  onReplace: () => void;
  onCancel: () => Promise<void>;
}> = ({ email, onReplace, onCancel }) => {
  const [busy, setBusy] = useState(false);
  return (
    <AuthShell
      title="Switch account on this device?"
      subtitle={`This device was last used with a different account. Continue as ${email || 'this account'}?`}
    >
      <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-300 list-disc pl-5">
        <li>The data on this device is replaced with this account’s data.</li>
        <li>Changes not yet synced to the other account are lost.</li>
        <li>If this account has no data yet, this device’s data is uploaded to it instead.</li>
      </ul>
      <div className="flex flex-col gap-2">
        <Button variant="primary" className="w-full justify-center" onClick={onReplace} disabled={busy}>
          <ArrowRightLeft className="h-4 w-4" />
          <span>Continue and switch</span>
        </Button>
        <Button
          variant="secondary"
          className="w-full justify-center"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onCancel().finally(() => setBusy(false));
          }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
          <span>Sign out</span>
        </Button>
      </div>
    </AuthShell>
  );
};

const SetPasswordScreen: React.FC<{ onDone: () => void; onCancel: () => Promise<void> }> = ({ onDone, onCancel }) => {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A reset link lands with its token in the address; keep it out of history.
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await updatePassword(password);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Choose a new password" subtitle="You opened a password reset link. Set a new password to continue.">
      <form className="space-y-3" onSubmit={(event) => void submit(event)} noValidate>
        <input
          type="password"
          autoComplete="new-password"
          placeholder={`New password (${MIN_PASSWORD_LENGTH}+ characters)`}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={authInputClass}
          disabled={busy}
          aria-label="New password"
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Repeat the new password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          className={authInputClass}
          disabled={busy}
          aria-label="Repeat the new password"
        />
        {error && (
          <p className="rounded-lg bg-rose-50 dark:bg-rose-950/50 px-3 py-2 text-xs text-rose-700 dark:text-rose-300" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full justify-center" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          <span>Save password</span>
        </Button>
      </form>
      <button
        type="button"
        onClick={() => void onCancel()}
        className="w-full text-center text-xs font-medium text-slate-500 dark:text-slate-400 hover:underline"
        disabled={busy}
      >
        Cancel and sign out
      </button>
    </AuthShell>
  );
};
