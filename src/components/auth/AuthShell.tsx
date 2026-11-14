import React, { useEffect } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style as StatusBarStyle } from '@capacitor/status-bar';
import { isNative } from '../../lib/platform';

export const authInputClass =
  'w-full rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60';

function storedTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('daily_tasks_theme_v1');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage unavailable: fall through to light, as the app does.
  }
  return 'light';
}

/**
 * Applies the saved theme and hides the native splash. The screens before
 * sign-in render without App, which normally does both.
 */
function usePreAppChrome() {
  useEffect(() => {
    const theme = storedTheme();
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.classList.toggle('light', theme !== 'dark');
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0f172a' : '#ffffff');
    if (isNative()) {
      void StatusBar.setStyle({ style: theme === 'dark' ? StatusBarStyle.Dark : StatusBarStyle.Light }).catch(() => {});
      void SplashScreen.hide().catch(() => {});
    }
  }, []);
}

interface AuthShellProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

/** Shared full-screen layout for the screens shown before the app opens. */
export const AuthShell: React.FC<AuthShellProps> = ({ title, subtitle, children }) => {
  usePreAppChrome();
  return (
    // Phones: the form sits in the upper half, so an on-screen keyboard that
    // overlays the page (Android edge-to-edge) cannot cover the fields.
    <main className="min-h-dvh overflow-y-auto bg-stone-50 dark:bg-slate-950 flex items-start sm:items-center justify-center px-4 pt-[max(2rem,calc(env(safe-area-inset-top)+1rem))] pb-[max(2rem,calc(env(safe-area-inset-bottom)+1rem))]">
      <div className="w-full max-w-sm space-y-5 sm:space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/20">
            <CheckCircle2 className="h-6 w-6" />
          </span>
          <p className="text-sm font-bold tracking-tight text-slate-500 dark:text-slate-400">Dayflow</p>
        </div>
        <section className="space-y-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 p-6 shadow-sm">
          <header className="space-y-1">
            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-50">{title}</h1>
            {subtitle && <p className="text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
          </header>
          {children}
        </section>
      </div>
    </main>
  );
};
