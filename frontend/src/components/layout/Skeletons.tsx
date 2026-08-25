/* ============================================================
   Skeleton placeholders — Laboratory Editorial loading states
   --------------------------------------------------------------
   Renders structural placeholders that mirror the final layout,
   so the loading view feels intentional rather than broken.
   ============================================================ */

interface SkeletonPageProps {
  eyebrow: string;
  status: string;
}

function PageSkeletonHeader({ eyebrow, status }: SkeletonPageProps) {
  return (
    <>
      <div className="loading-meta" aria-hidden="true">
        <span>{status}</span>
      </div>
      <div className="skeleton skeleton-eyebrow" aria-hidden="true" />
      <div className="skeleton skeleton-title" aria-hidden="true" />
      <div style={{ marginBottom: '2.5rem', maxWidth: '64ch' }} aria-hidden="true">
        <div className="skeleton skeleton-paragraph" />
        <div className="skeleton skeleton-paragraph" style={{ width: '52ch' }} />
        <div className="skeleton skeleton-paragraph" style={{ width: '38ch' }} />
      </div>
      <span className="sr-only">{eyebrow} — loading content. Please wait.</span>
    </>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="page-container" role="status" aria-live="polite" aria-busy="true">
      <PageSkeletonHeader eyebrow="Dashboard" status="LOADING · SURVEILLANCE FEED" />

      {/* Stats grid skeleton */}
      <div className="stats-grid" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <div className="skeleton-stat-card" key={i}>
            <span className="skeleton-tick">{`0${i}/04`}</span>
            <div className="skeleton skeleton-stat-label" />
            <div className="skeleton skeleton-stat-value" />
            <div className="skeleton-stat-rule" />
          </div>
        ))}
      </div>

      {/* Charts grid skeleton */}
      <div className="charts-grid" aria-hidden="true">
        <div className="skeleton-chart-card">
          <div className="skeleton skeleton-chart-title" />
          <div className="skeleton-chart-body">
            {/* Pseudo "pie" rendered as a stacked bar cluster — visually distinct */}
            <div className="skeleton-bar" />
            <div className="skeleton-bar" />
            <div className="skeleton-bar" />
            <div className="skeleton-bar" />
            <div className="skeleton-bar" />
          </div>
        </div>
        <div className="skeleton-chart-card">
          <div className="skeleton skeleton-chart-title" style={{ width: '32%' }} />
          <div className="skeleton-chart-body">
            <div className="skeleton-bar" />
            <div className="skeleton-bar" />
            <div className="skeleton-bar" />
            <div className="skeleton-bar" />
            <div className="skeleton-bar" />
            <div className="skeleton-bar" />
            <div className="skeleton-bar" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function WorkflowsSkeleton() {
  return (
    <div className="page-container" role="status" aria-live="polite" aria-busy="true">
      <PageSkeletonHeader eyebrow="Executions" status="LOADING · RUN HISTORY" />

      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          overflow: 'hidden',
        }}
        aria-hidden="true"
      >
        {/* Header bar */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1fr 0.5fr',
            gap: '1rem',
            padding: '0.75rem 1.25rem',
            background: 'var(--bg-secondary)',
            borderBottom: '1px solid var(--border-color)',
            fontSize: '0.75rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <span>Execution ID</span>
          <span>Start Time</span>
          <span>Duration</span>
          <span>Status</span>
          <span>Isolates</span>
          <span>Detail</span>
        </div>

        {/* Skeleton rows */}
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div className="skeleton-row" key={i} style={{ animationDelay: `${i * 0.06}s` }}>
            <span className="skeleton cell-id" />
            <span className="skeleton cell-time" />
            <span className="skeleton cell-dur" />
            <span className="skeleton cell-status" />
            <span className="skeleton cell-iso" />
            <span className="skeleton cell-tog" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function IngestionSkeleton() {
  return (
    <div className="page-container" role="status" aria-live="polite" aria-busy="true">
      <PageSkeletonHeader eyebrow="Ingestion" status="LOADING · PIPELINE ENTRY" />

      <div className="card" aria-hidden="true">
        <div
          className="skeleton"
          style={{ height: '0.75rem', width: '14rem', marginBottom: '1rem' }}
        />
        <div
          className="skeleton"
          style={{ height: '14rem', width: '100%', marginBottom: '1.25rem' }}
        />
        <div
          className="skeleton"
          style={{
            height: '2.875rem',
            width: '14rem',
            background:
              'linear-gradient(90deg, color-mix(in srgb, var(--accent-primary) 28%, var(--bg-elevated)) 0%, color-mix(in srgb, var(--accent-primary) 40%, var(--bg-elevated)) 50%, color-mix(in srgb, var(--accent-primary) 28%, var(--bg-elevated)) 100%)',
            backgroundSize: '200% 100%',
            border: '1px solid var(--accent-primary)',
          }}
        />
      </div>
    </div>
  );
}

export function ChatSkeleton() {
  return (
    <div className="page-container" role="status" aria-live="polite" aria-busy="true">
      <PageSkeletonHeader eyebrow="Chat" status="LOADING · INTERACTIVE CONSOLE" />
      <div className="card" aria-hidden="true">
        <div className="skeleton skeleton-text long" />
        <div className="skeleton skeleton-text medium" />
        <div className="skeleton skeleton-text short" />
        <div style={{ height: '1.5rem' }} />
        <div className="skeleton skeleton-text long" />
        <div className="skeleton skeleton-text medium" />
      </div>
    </div>
  );
}

export function FullPageLoader() {
  return (
    <div
      className="page-loader-fullscreen"
      role="status"
      aria-live="polite"
      aria-label="Loading content"
    >
      <div className="petri-loader" aria-hidden="true" />
      <div className="loading-label">
        <strong>·</strong>&nbsp;&nbsp;Culturing surveillance feed&nbsp;&nbsp;<strong>·</strong>
      </div>
    </div>
  );
}
