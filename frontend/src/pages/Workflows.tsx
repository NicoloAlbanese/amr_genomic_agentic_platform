import { useEffect, useState, useCallback } from 'react';
import { apiGet } from '../hooks/useApi';
import { WorkflowsSkeleton } from '../components/layout/Skeletons';

// --- Types ---

interface StageStatus {
  stage: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
}

interface WorkflowExecution {
  executionId: string;
  startTime: string;
  endTime?: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'ABORTED';
  isolateCount?: number;
  stages?: StageStatus[];
}

interface WorkflowsResponse {
  items?: WorkflowExecution[];
  executions?: WorkflowExecution[];
  nextToken?: string;
}

interface WorkflowDetailResponse {
  executionId: string;
  status: string;
  stages?: StageStatus[];
  isolateCount?: number;
}

// --- Helpers ---

function formatDateTime(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function formatDuration(startTime?: string, endTime?: string): string {
  if (!startTime) return '—';
  const start = new Date(startTime).getTime();
  if (Number.isNaN(start)) return '—';
  const end = endTime ? new Date(endTime).getTime() : Date.now();
  const diffMs = end - start;
  if (diffMs < 0 || Number.isNaN(diffMs)) return '—';
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    RUNNING: 'var(--accent-primary)',
    SUCCEEDED: 'var(--accent-success)',
    FAILED: 'var(--accent-danger)',
    TIMED_OUT: 'var(--accent-warning)',
    ABORTED: 'var(--text-secondary)',
  };
  const color = colors[status] ?? 'var(--text-secondary)';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.125rem 0.625rem',
        borderRadius: '12px',
        fontSize: '0.75rem',
        fontWeight: 600,
        border: `1px solid ${color}`,
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        fontFamily: 'var(--font-mono)',
      }}
      aria-label={`Status: ${status}`}
    >
      {status}
    </span>
  );
}

function StageRow({ stage }: { stage: StageStatus }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        padding: '0.375rem 0',
        fontSize: '0.8125rem',
      }}
    >
      <span style={{ width: '180px', color: 'var(--text-secondary)' }}>{stage.stage}</span>
      <StatusBadge status={stage.status} />
      {stage.startedAt && (
        <span style={{ color: 'var(--text-secondary)' }}>
          {formatDuration(stage.startedAt, stage.completedAt)}
        </span>
      )}
    </div>
  );
}

// --- Main Component ---

const PAGE_SIZE = 20;

export function Workflows() {
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<WorkflowDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [page, setPage] = useState(0);
  const [allPages, setAllPages] = useState<WorkflowExecution[][]>([]);

  const fetchPage = useCallback(async (token?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (token) params.set('nextToken', token);
      const res = await apiGet<WorkflowsResponse>(`workflows?${params}`);
      const items: WorkflowExecution[] = res.items ?? res.executions ?? [];
      setAllPages((prev) => {
        const updated = [...prev];
        const idx = token ? prev.length : 0;
        updated[idx] = items;
        return updated;
      });
      setExecutions(items);
      setNextToken(res.nextToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workflows');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  // Poll every 5s when any execution is RUNNING
  useEffect(() => {
    const hasRunning = executions.some((e) => e.status === 'RUNNING');
    if (!hasRunning) return;
    const interval = setInterval(() => {
      void fetchPage(page > 0 ? allPages[page - 1]?.at(-1)?.executionId : undefined);
    }, 5000);
    return () => clearInterval(interval);
  }, [executions, fetchPage, page, allPages]);

  // Fetch detail when row is expanded
  useEffect(() => {
    if (!expandedId) {
      setExpandedDetail(null);
      return;
    }
    let cancelled = false;
    apiGet<WorkflowDetailResponse>(`workflows/${expandedId}`)
      .then((d) => { if (!cancelled) setExpandedDetail(d); })
      .catch(() => { /* detail is optional */ });
    return () => { cancelled = true; };
  }, [expandedId]);

  const handlePrevPage = () => {
    if (page === 0) return;
    const newPage = page - 1;
    setPage(newPage);
    setExecutions(allPages[newPage]);
  };

  const handleNextPage = () => {
    const newPage = page + 1;
    if (allPages[newPage]) {
      setPage(newPage);
      setExecutions(allPages[newPage]);
    } else if (nextToken) {
      setPage(newPage);
      void fetchPage(nextToken);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  if (loading && executions.length === 0) {
    return <WorkflowsSkeleton />;
  }

  return (
    <div className="page-container">
      <div className="page-eyebrow">RUN HISTORY · LIVE FEED</div>
      <h1>Executions.</h1>
      <p style={{ color: 'var(--text-secondary)', maxWidth: '64ch', margin: '0 0 2.5rem', fontSize: '1.0625rem', lineHeight: 1.6 }}>
        Track every assembly, gene scan, ETL, and annotation stage as each isolate moves through the pipeline.
      </p>

      {error && (
        <div className="error" role="alert" id="workflows-error">
          {error}
        </div>
      )}

      {executions.length === 0 && !loading ? (
        <div className="empty-state">No workflow executions found.</div>
      ) : (
        <div
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            overflow: 'hidden',
          }}
          role="region"
          aria-label="Workflow executions table"
        >
          {/* Table header */}
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
            }}
            role="row"
          >
            <span role="columnheader">Execution ID</span>
            <span role="columnheader">Start Time</span>
            <span role="columnheader">Duration</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Isolates</span>
            <span role="columnheader">Detail</span>
          </div>

          {/* Table rows */}
          {executions.map((exec) => (
            <div key={exec.executionId} role="rowgroup">
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1.5fr 1fr 1fr 1fr 0.5fr',
                  gap: '1rem',
                  padding: '0.875rem 1.25rem',
                  borderBottom: '1px solid var(--border-color)',
                  alignItems: 'center',
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                  background: expandedId === exec.executionId
                    ? 'color-mix(in srgb, var(--accent-primary) 5%, transparent)'
                    : 'transparent',
                }}
                role="row"
                onClick={() => toggleExpand(exec.executionId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleExpand(exec.executionId);
                  }
                }}
                tabIndex={0}
                aria-expanded={expandedId === exec.executionId}
                aria-label={`Workflow execution ${exec.executionId}`}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.8125rem',
                    color: 'var(--accent-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={exec.executionId}
                  role="cell"
                >
                  {exec.executionId}
                </span>
                <span role="cell" style={{ color: 'var(--text-secondary)' }}>
                  {formatDateTime(exec.startTime)}
                </span>
                <span role="cell" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                  {formatDuration(exec.startTime, exec.endTime)}
                </span>
                <span role="cell">
                  <StatusBadge status={exec.status} />
                </span>
                <span role="cell" style={{ color: 'var(--text-secondary)' }}>
                  {exec.isolateCount ?? '—'}
                </span>
                <span role="cell" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                  {expandedId === exec.executionId ? '▲' : '▼'}
                </span>
              </div>

              {/* Expanded detail row */}
              {expandedId === exec.executionId && (
                <div
                  style={{
                    padding: '1rem 1.25rem 1.25rem 1.25rem',
                    borderBottom: '1px solid var(--border-color)',
                    background: 'color-mix(in srgb, var(--bg-secondary) 50%, transparent)',
                  }}
                  role="region"
                  aria-label={`Details for execution ${exec.executionId}`}
                >
                  {expandedDetail ? (
                    <>
                      <div style={{ marginBottom: '0.5rem', fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                        <strong style={{ color: 'var(--text-primary)' }}>Stage Status</strong>
                      </div>
                      {expandedDetail.stages && expandedDetail.stages.length > 0 ? (
                        expandedDetail.stages.map((s) => (
                          <StageRow key={s.stage} stage={s} />
                        ))
                      ) : (
                        <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                          No stage detail available.
                        </p>
                      )}
                      {expandedDetail.isolateCount !== undefined && (
                        <div style={{ marginTop: '0.75rem', fontSize: '0.8125rem' }}>
                          <strong style={{ color: 'var(--text-secondary)' }}>Isolates processed:</strong>{' '}
                          <span style={{ color: 'var(--text-primary)' }}>{expandedDetail.isolateCount}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                      Loading detail...
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: '1rem',
        }}
        role="navigation"
        aria-label="Workflow pagination"
      >
        <button
          type="button"
          onClick={handlePrevPage}
          disabled={page === 0}
          aria-label="Previous page"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-primary)',
            padding: '0.5rem 1rem',
            borderRadius: '6px',
          }}
        >
          Previous
        </button>
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
          Page {page + 1}
        </span>
        <button
          type="button"
          onClick={handleNextPage}
          disabled={!nextToken && !allPages[page + 1]}
          aria-label="Next page"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            color: 'var(--text-primary)',
            padding: '0.5rem 1rem',
            borderRadius: '6px',
          }}
        >
          Next
        </button>
      </div>

      {loading && executions.length > 0 && (
        <div role="status" aria-live="polite" style={{ textAlign: 'center', marginTop: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
          Refreshing...
        </div>
      )}
    </div>
  );
}
