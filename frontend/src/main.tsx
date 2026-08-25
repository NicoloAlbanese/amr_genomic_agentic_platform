import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import App from './App';
import { loadRuntimeConfig } from './config';
import './styles/global.css';

// Bootstrap: load runtime config, configure Amplify, then render. Doing this
// before render guarantees Amplify has real Cognito values (fetched at runtime,
// not baked into the bundle) and avoids a blank page when config is wrong.
async function bootstrap(): Promise<void> {
  const config = await loadRuntimeConfig();

  // Auth is handled in-app via Amplify SRP username/password (see pages/Login),
  // so only the user pool + client are needed here — no Hosted UI OAuth config.
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
      },
    },
  });

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

bootstrap().catch((err) => {
  // Render a minimal, honest error instead of a silent blank page.
  console.error('Application bootstrap failed:', err);
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML =
      '<div style="font-family:system-ui;padding:2rem;max-width:40rem;margin:0 auto">' +
      '<h1>Configuration error</h1>' +
      '<p>The application could not load its runtime configuration ' +
      '(<code>/runtime-config.json</code>). Check that the frontend stack deployed ' +
      'successfully and the file is present.</p></div>';
  }
});
