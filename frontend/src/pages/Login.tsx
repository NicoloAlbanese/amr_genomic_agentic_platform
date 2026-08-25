import { useState, useCallback } from 'react';
import { signIn, confirmSignIn } from 'aws-amplify/auth';

interface LoginProps {
  onSignedIn: () => void;
}

/**
 * In-app login screen styled to match the platform (amber-on-carbon petri-dish
 * aesthetic). Uses Amplify SRP username/password auth so we control the UI,
 * rather than redirecting to the Cognito Hosted UI.
 */
export function Login({ onSignedIn }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [needsNewPassword, setNeedsNewPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setSubmitting(true);
      try {
        if (needsNewPassword) {
          const { isSignedIn } = await confirmSignIn({ challengeResponse: newPassword });
          if (isSignedIn) onSignedIn();
          return;
        }

        const { isSignedIn, nextStep } = await signIn({
          username: email.trim(),
          password,
          options: { authFlowType: 'USER_SRP_AUTH' },
        });

        if (isSignedIn) {
          onSignedIn();
        } else if (nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
          // First-login flow: the user must set a permanent password.
          setNeedsNewPassword(true);
        } else {
          setError('Additional sign-in step required. Contact your administrator.');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Sign in failed';
        // Normalise the most common Cognito errors to plain language.
        if (/incorrect username or password/i.test(message) || /NotAuthorized/i.test(message)) {
          setError('Incorrect email or password.');
        } else if (/UserNotFound/i.test(message)) {
          setError('No account found for that email.');
        } else {
          setError(message);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [email, password, newPassword, needsNewPassword, onSignedIn],
  );

  return (
    <div className="auth-screen">
      <div className="auth-panel" role="main" aria-label="Sign in">
        <div className="auth-brand">
          <img src="/favicon.svg" alt="" className="nav-brand-logo" aria-hidden="true" />
          <span className="auth-brand-text">
            AMR Sequence Intelligence
            <span className="auth-brand-mark">v1</span>
          </span>
        </div>

        <div className="auth-eyebrow">SECURE ACCESS · AMR SURVEILLANCE</div>
        <h1 className="auth-title">Sign in.</h1>
        <p className="auth-subtitle">
          Antimicrobial resistance surveillance for public health genomics.
        </p>

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <label className="auth-label" htmlFor="login-email">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            className="auth-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting || needsNewPassword}
            required
            aria-required="true"
          />

          <label className="auth-label" htmlFor="login-password">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            className="auth-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting || needsNewPassword}
            required
            aria-required="true"
          />

          {needsNewPassword && (
            <>
              <label className="auth-label" htmlFor="login-new-password">
                Set a new password
              </label>
              <input
                id="login-new-password"
                type="password"
                autoComplete="new-password"
                className="auth-input"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={submitting}
                required
                aria-required="true"
              />
              <p className="auth-hint">
                Your account requires a new password on first sign in.
              </p>
            </>
          )}

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn-primary auth-submit"
            disabled={
              submitting ||
              (!needsNewPassword && (!email.trim() || !password)) ||
              (needsNewPassword && !newPassword)
            }
          >
            {submitting ? 'Signing in…' : needsNewPassword ? 'Set password & continue' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
