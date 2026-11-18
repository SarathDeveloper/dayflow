import {StrictMode, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { AuthGate } from './components/auth/AuthGate';
import { AppDialogHost } from './components/ui/AppDialog';
import { RootErrorBoundary } from './components/RootErrorBoundary';
import { migrateToSingleProfile } from './lib/singleProfile';
import { checkForUpdates, confirmAppReady, lastUpdateCheckAt, startAppUpdater } from './services/appUpdater';
import { installErrorReporter } from './services/errorReporter';

// Crash reports (signed-in users only; no app data, see lib/errorReport.ts).
installErrorReporter();

// Fold a signed-in profile into the default keys before React reads storage.
migrateToSingleProfile();

/**
 * Confirms to the Android updater that this app code works. It only mounts
 * once the first screen has rendered, so code that crashes while rendering is
 * not confirmed and gets rolled back.
 */
function ReadyReporter(): null {
  useEffect(() => {
    void confirmAppReady();
  }, []);
  return null;
}

function render(): void {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <RootErrorBoundary>
        {/* Login is required: the app mounts only once a session exists. */}
        <AuthGate>{({ justSignedIn }) => <App skipInitialLock={justSignedIn} />}</AuthGate>
        <ReadyReporter />
      </RootErrorBoundary>
      {/* Branded alerts and confirmations (showAlert / showConfirm), on every screen. */}
      <AppDialogHost />
    </StrictMode>,
  );
  // Android: also look for updates outside the signed-in app, so a phone stuck on
  // the login or error screen can still fetch a fixed release.
  window.setTimeout(() => {
    if (Date.now() - lastUpdateCheckAt() > 60_000) void checkForUpdates();
  }, 20_000);
}

// Android: switch to a downloaded update behind the splash screen before
// anything renders.
void startAppUpdater()
  .catch(() => false)
  .then((reloading) => {
    if (!reloading) {
      render();
      return;
    }
    // The switch reloads the app; render anyway if it somehow does not.
    window.setTimeout(render, 4000);
  });
