interface LogoutProps {
  onSignInAgain: () => void;
}

/**
 * Signed-out confirmation screen, styled to match the platform. Shown after the
 * user signs out; offers a single action to return to the sign-in screen.
 */
export function Logout({ onSignInAgain }: LogoutProps) {
  return (
    <div className="auth-screen">
      <div className="auth-panel" role="main" aria-label="Signed out">
        <div className="auth-brand">
          <img src="/favicon.svg" alt="" className="nav-brand-logo" aria-hidden="true" />
          <span className="auth-brand-text">
            AMR Sequence Intelligence
            <span className="auth-brand-mark">v1</span>
          </span>
        </div>

        <div className="auth-eyebrow">SESSION ENDED</div>
        <h1 className="auth-title">Signed out.</h1>
        <p className="auth-subtitle">
          Your session has ended. Sign in again to continue working with AMR surveillance data.
        </p>

        <button type="button" className="btn-primary auth-submit" onClick={onSignInAgain}>
          Sign in again
        </button>
      </div>
    </div>
  );
}
