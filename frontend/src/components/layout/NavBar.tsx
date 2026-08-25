import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { signOut } from 'aws-amplify/auth';
import { getStoredTheme, applyTheme, toggleTheme, type Theme } from '../../styles/theme';

export function NavBar() {
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const location = useLocation();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const handleToggleTheme = () => {
    setTheme((current: Theme) => {
      const next = toggleTheme(current);
      return next;
    });
  };

  const handleSignOut = () => {
    signOut()
      .then(() => {
        window.dispatchEvent(new Event('amr:signed-out'));
      })
      .catch((err: unknown) => {
        console.error('Sign out error:', err);
        // Even if the hosted sign-out call fails, drop the local session view.
        window.dispatchEvent(new Event('amr:signed-out'));
      });
  };

  const isActive = (path: string) => location.pathname === path;

  return (
    <nav className="navbar">
      <div className="nav-brand">
        <img src="/favicon.svg" alt="" className="nav-brand-logo" aria-hidden="true" />
        AMR Sequence Intelligence
        <span className="nav-brand-mark">v1</span>
      </div>

      <div className="nav-links">
        <Link to="/dashboard" className={isActive('/dashboard') ? 'active' : ''}>
          Dashboard
        </Link>
        <Link to="/ingestion" className={isActive('/ingestion') ? 'active' : ''}>
          Ingestion
        </Link>
        <Link to="/workflows" className={isActive('/workflows') ? 'active' : ''}>
          Workflows
        </Link>
        <Link to="/chat" className={isActive('/chat') ? 'active' : ''}>
          Chat
        </Link>
      </div>

      <div className="nav-actions">
        <button
          type="button"
          className="btn-icon"
          onClick={handleToggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? 'LIGHT' : 'DARK'}
        </button>
        <button
          type="button"
          className="btn-signout"
          onClick={handleSignOut}
        >
          Sign Out
        </button>
      </div>
    </nav>
  );
}
