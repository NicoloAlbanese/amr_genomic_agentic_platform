import { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { apiGet } from '../hooks/useApi';
import { DashboardSkeleton } from '../components/layout/Skeletons';

// --- Types ---

interface WorkflowItem {
  executionId: string;
  status: string;
  organism?: string;
  createdAt?: string;
}

interface IsolateItem {
  isolateId: string;
  organism?: string;
  amrGenes?: string[];
}

interface WorkflowsResponse {
  items?: WorkflowItem[];
  executions?: WorkflowItem[];
}

interface IsolatesResponse {
  items?: IsolateItem[];
  isolates?: IsolateItem[];
}

interface OrgCount {
  name: string;
  count: number;
}

interface GeneCount {
  gene: string;
  count: number;
}

// --- Colour palette for charts (uses CSS vars where possible) ---

// Spectral neon palette, matching the DNA-helix backdrop.
const CHART_COLORS = [
  '#35e6d0', // cyan-teal
  '#7c6cff', // violet
  '#6ce36b', // helix green
  '#ff5da2', // magenta
  '#f5e663', // signal yellow
  '#4aa3ff', // blue
  '#ff9d5c', // amber-orange
];

// --- Dashboard component ---

export function Dashboard() {
  const [totalIsolates, setTotalIsolates] = useState<number | null>(null);
  const [totalWorkflows, setTotalWorkflows] = useState<number | null>(null);
  const [orgData, setOrgData] = useState<OrgCount[]>([]);
  const [geneData, setGeneData] = useState<GeneCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const [workflowsRes, isolatesRes] = await Promise.all([
          apiGet<WorkflowsResponse>('workflows').catch(() => ({ items: [] as WorkflowItem[] } as WorkflowsResponse)),
          apiGet<IsolatesResponse>('isolates').catch(() => ({ items: [] as IsolateItem[] } as IsolatesResponse)),
        ]);

        if (cancelled) return;

        const workflows: WorkflowItem[] = workflowsRes.items ?? workflowsRes.executions ?? [];
        const isolates: IsolateItem[] = isolatesRes.items ?? isolatesRes.isolates ?? [];

        setTotalWorkflows(workflows.length);
        setTotalIsolates(isolates.length);

        // Organism breakdown (pie chart)
        const orgCounts: Record<string, number> = {};
        for (const iso of isolates) {
          const org = iso.organism ?? 'Unknown';
          orgCounts[org] = (orgCounts[org] ?? 0) + 1;
        }
        setOrgData(
          Object.entries(orgCounts)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 7),
        );

        // AMR gene frequency (bar chart)
        const geneCounts: Record<string, number> = {};
        for (const iso of isolates) {
          for (const gene of iso.amrGenes ?? []) {
            geneCounts[gene] = (geneCounts[gene] ?? 0) + 1;
          }
        }
        setGeneData(
          Object.entries(geneCounts)
            .map(([gene, count]) => ({ gene, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10),
        );
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchData();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <DashboardSkeleton />;
  }

  if (error) {
    return (
      <div className="page-container">
        <h1>Dashboard</h1>
        <div className="error-state">
          <p>Failed to load data: {error}</p>
          <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
            Check your network connection or API configuration.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-eyebrow">SURVEILLANCE CONSOLE · LIVE FEED</div>
      <h1>Dashboard.</h1>
      <p style={{ color: 'var(--text-secondary)', maxWidth: '64ch', marginBottom: '2.5rem', fontSize: '1.0625rem', lineHeight: 1.6 }}>
        A live view of antimicrobial resistance signals across your isolate corpus: organism
        distribution, gene frequencies, and pipeline throughput, updated as runs complete.
      </p>

      {/* Stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total Isolates</div>
          <div className="stat-value">{totalIsolates ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Workflow Runs</div>
          <div className="stat-value">{totalWorkflows ?? '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Organisms</div>
          <div className="stat-value">{orgData.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Unique AMR Genes</div>
          <div className="stat-value">{geneData.length}</div>
        </div>
      </div>

      {/* Charts */}
      <div className="charts-grid">
        {/* Organism breakdown — Pie */}
        <div className="chart-card">
          <h2>Organism Breakdown</h2>
          {orgData.length === 0 ? (
            <div className="empty-state">No isolate data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={orgData}
                  dataKey="count"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={90}
                  label={({ name, percent }: { name: string; percent: number }) =>
                    `${name} (${(percent * 100).toFixed(0)}%)`
                  }
                  labelLine={false}
                >
                  {orgData.map((_entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={CHART_COLORS[index % CHART_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    color: 'var(--text-primary)',
                  }}
                  itemStyle={{ color: 'var(--text-primary)' }}
                  labelStyle={{ color: 'var(--text-secondary)' }}
                  formatter={(value: number, name: string) => [`${value}`, name]}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* AMR gene frequency — Bar */}
        <div className="chart-card">
          <h2>Top AMR Genes</h2>
          {geneData.length === 0 ? (
            <div className="empty-state">No gene data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={geneData} layout="vertical" margin={{ left: 20, right: 20 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border-color)"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                  axisLine={{ stroke: 'var(--border-color)' }}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="gene"
                  tick={{
                    fill: 'var(--text-secondary)',
                    fontSize: 12,
                    fontFamily: 'var(--font-mono)',
                  }}
                  axisLine={{ stroke: 'var(--border-color)' }}
                  tickLine={false}
                  width={80}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    color: 'var(--text-primary)',
                  }}
                  itemStyle={{ color: 'var(--text-primary)' }}
                  labelStyle={{ color: 'var(--text-secondary)' }}
                  cursor={{ fill: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' }}
                />
                <Bar dataKey="count" fill="var(--accent-primary)" radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
