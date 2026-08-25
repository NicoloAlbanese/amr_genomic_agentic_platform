import { useEffect, useState, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import { getCurrentUser } from 'aws-amplify/auth';
import { Login } from '../../pages/Login';
import { Logout } from '../../pages/Logout';

type AuthState = 'checking' | 'signedOut' | 'loggedOut' | 'authed';

/**
 * Gate for authenticated routes. Renders the in-app Login screen when the user
 * is not authenticated (instead of redirecting to the Cognito Hosted UI), and a
 * styled signed-out screen after an explicit sign out. This keeps the whole auth
 * experience in the platform's visual language.
 */
export function AuthGuard() {
  const [state, setState] = useState<AuthState>('checking');

  const checkAuth = useCallback(() => {
    setState('checking');
    getCurrentUser()
      .then(() => setState('authed'))
      .catch(() => setState('signedOut'));
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Broadcast sign-out from the NavBar via a window event so the guard can swap
  // to the signed-out screen without a full reload.
  useEffect(() => {
    const onSignedOut = () => setState('loggedOut');
    window.addEventListener('amr:signed-out', onSignedOut);
    return () => window.removeEventListener('amr:signed-out', onSignedOut);
  }, []);

  if (state === 'checking') {
    return (
      <div
        className="page-loader-fullscreen"
        role="status"
        aria-live="polite"
        aria-label="Authenticating"
      >
        <div className="petri-loader" aria-hidden="true" />
        <div className="loading-label">
          <strong>·</strong>&nbsp;&nbsp;Authenticating credentials&nbsp;&nbsp;<strong>·</strong>
        </div>
      </div>
    );
  }

  if (state === 'loggedOut') {
    return <Logout onSignInAgain={() => setState('signedOut')} />;
  }

  if (state === 'signedOut') {
    return <Login onSignedIn={() => setState('authed')} />;
  }

  return <Outlet />;
}
