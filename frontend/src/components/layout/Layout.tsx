import { Outlet } from 'react-router-dom';
import { NavBar } from './NavBar';
import { HelixBackground } from './HelixBackground';

export function Layout() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-primary)',
      }}
    >
      <HelixBackground />
      {/* Skip-to-content link for keyboard/screen reader users */}
      <a
        href="#main-content"
        style={{
          position: 'absolute',
          left: '-9999px',
          top: 'auto',
          width: '1px',
          height: '1px',
          overflow: 'hidden',
          zIndex: -1,
        }}
        onFocus={(e) => {
          e.currentTarget.style.position = 'fixed';
          e.currentTarget.style.left = '0.5rem';
          e.currentTarget.style.top = '0.5rem';
          e.currentTarget.style.width = 'auto';
          e.currentTarget.style.height = 'auto';
          e.currentTarget.style.overflow = 'visible';
          e.currentTarget.style.zIndex = '9999';
          e.currentTarget.style.padding = '0.5rem 1rem';
          e.currentTarget.style.background = 'var(--accent-primary)';
          e.currentTarget.style.color = '#fff';
          e.currentTarget.style.borderRadius = '6px';
          e.currentTarget.style.fontWeight = '600';
          e.currentTarget.style.outline = '3px solid var(--bg-primary)';
        }}
        onBlur={(e) => {
          e.currentTarget.style.position = 'absolute';
          e.currentTarget.style.left = '-9999px';
          e.currentTarget.style.top = 'auto';
          e.currentTarget.style.width = '1px';
          e.currentTarget.style.height = '1px';
          e.currentTarget.style.overflow = 'hidden';
          e.currentTarget.style.zIndex = '-1';
        }}
      >
        Skip to main content
      </a>

      <NavBar />
      <main id="main-content" style={{ flex: 1 }} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
