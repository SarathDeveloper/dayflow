import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { AuthGate } from './components/auth/AuthGate';
import { migrateToSingleProfile } from './lib/singleProfile';

// Fold a signed-in profile into the default keys before React reads storage.
migrateToSingleProfile();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Login is required: the app mounts only once a session exists. */}
    <AuthGate>{({ justSignedIn }) => <App skipInitialLock={justSignedIn} />}</AuthGate>
  </StrictMode>,
);
