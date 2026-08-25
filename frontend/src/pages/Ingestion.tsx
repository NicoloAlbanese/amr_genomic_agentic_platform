import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiPost } from '../hooks/useApi';

interface TriggerResponse {
  executionId: string;
  accessions?: string[];
}

/**
 * Curated public foodborne-pathogen surveillance accessions. All are real
 * Salmonella enterica whole-genome sequencing runs hosted in the AWS Open Data
 * SRA bucket (s3://sra-pub-run-odp), so they ingest with no NCBI credentials and
 * no egress cost. They come from the major US surveillance programs (FDA
 * GenomeTrakr and USDA-FSIS NARMS), which makes them representative demo isolates.
 */
const CURATED_ISOLATES: { accession: string; label: string; source: string }[] = [
  { accession: 'SRR1583085', label: 'S. enterica ser. Reading', source: 'FDA GenomeTrakr (Arizona)' },
  { accession: 'SRR5487998', label: 'S. enterica', source: 'FDA GenomeTrakr (Maryland)' },
  { accession: 'SRR5514434', label: 'S. enterica (FSIS1700592)', source: 'USDA-FSIS NARMS' },
];

const SRA_BROWSER_URL = 'https://www.ncbi.nlm.nih.gov/sra/?term=salmonella+wgs';

// SRA run accessions are an SRR/ERR/DRR prefix followed by digits.
const ACCESSION_RE = /^(SRR|ERR|DRR)\d+$/i;

type Mode = 'curated' | 'custom';

interface ParsedAccession {
  value: string;
  valid: boolean;
}

/**
 * Split free text into candidate accessions (one per line or whitespace-
 * separated), upper-case them, drop blanks and duplicates, and flag validity.
 */
function parseAccessions(text: string): ParsedAccession[] {
  const seen = new Set<string>();
  const out: ParsedAccession[] = [];
  for (const token of text.split(/[\s,]+/)) {
    const value = token.trim().toUpperCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, valid: ACCESSION_RE.test(value) });
  }
  return out;
}

export function Ingestion() {
  const [mode, setMode] = useState<Mode>('curated');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customText, setCustomText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TriggerResponse | null>(null);

  const parsedCustom = useMemo(() => parseAccessions(customText), [customText]);

  // The accessions that will actually be submitted, resolved from whichever
  // entry mode is active. Curated selections are always valid; custom entries
  // must pass the accession format check.
  const submitList = useMemo<string[]>(() => {
    if (mode === 'curated') return [...selected];
    return parsedCustom.filter((p) => p.valid).map((p) => p.value);
  }, [mode, selected, parsedCustom]);

  const invalidCount = mode === 'custom' ? parsedCustom.filter((p) => !p.valid).length : 0;
  const canSubmit = !loading && submitList.length > 0 && invalidCount === 0;

  const toggleCurated = (accession: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(accession)) next.delete(accession);
      else next.add(accession);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      // Backend accepts {accessionId} (single) or {accessions: [...]} (array).
      const payload =
        submitList.length === 1
          ? { accessionId: submitList[0] }
          : { accessions: submitList };
      const res = await apiPost<TriggerResponse>('ingestion/trigger', payload);
      setResult({ executionId: res.executionId, accessions: res.accessions ?? submitList });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to trigger ingestion.');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setResult(null);
    setError(null);
    setSelected(new Set());
    setCustomText('');
  };

  // --- Success view -------------------------------------------------------
  if (result) {
    const submitted = result.accessions ?? [];
    const durationHint =
      submitted.length > 1
        ? `The ${submitted.length} isolates run in parallel; expect roughly 30 to 90 minutes.`
        : 'Expect roughly 30 to 90 minutes for the run to complete.';
    return (
      <div className="page-container">
        <div className="page-eyebrow">PIPELINE ENTRY · SUBMITTED</div>
        <h1>Submitted.</h1>
        <div className="card" role="status" aria-live="polite">
          <label>Run accepted</label>
          <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '1rem' }}>
            The pipeline is now fetching, assembling, and scanning{' '}
            {submitted.length === 1 ? 'the isolate' : `${submitted.length} isolates`} for AMR genes.
          </p>

          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1.5rem', margin: '0 0 1.25rem' }}>
            <dt style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.14em' }}>
              Execution ID
            </dt>
            <dd className="gene-name" style={{ margin: 0, color: 'var(--accent-primary)', wordBreak: 'break-all' }}>
              {result.executionId}
            </dd>
            <dt style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.14em' }}>
              Accessions
            </dt>
            <dd className="gene-name" style={{ margin: 0, color: 'var(--text-primary)' }}>
              {submitted.join(', ')}
            </dd>
          </dl>

          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', lineHeight: 1.6, marginBottom: '1.25rem' }}>
            {durationHint} You can track each stage on the Workflows page.
          </p>

          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link
              to="/workflows"
              className="btn-trigger"
              style={{ textDecoration: 'none', display: 'inline-block' }}
            >
              View in Workflows
            </Link>
            <button type="button" onClick={resetForm} className="btn-icon">
              Submit another
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- Entry view ---------------------------------------------------------
  return (
    <div className="page-container">
      <div className="page-eyebrow">PIPELINE ENTRY · SUBMIT</div>
      <h1>Ingestion.</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem', maxWidth: '64ch', fontSize: '1.0625rem', lineHeight: 1.6 }}>
        Queue NCBI SRA run accessions for AMR analysis. Each accession is pulled from the AWS Open
        Data SRA mirror, assembled with fastp and SKESA, then scanned for resistance genes with
        AMRFinderPlus on AWS HealthOmics.
      </p>

      {/* Mode toggle */}
      <div
        role="tablist"
        aria-label="Ingestion entry mode"
        style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'curated'}
          onClick={() => setMode('curated')}
          className={mode === 'curated' ? 'btn-primary' : 'btn-icon'}
        >
          Curated isolates
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'custom'}
          onClick={() => setMode('custom')}
          className={mode === 'custom' ? 'btn-primary' : 'btn-icon'}
        >
          Custom accessions
        </button>
      </div>

      {mode === 'curated' ? (
        <div className="card">
          <label>Curated public isolates</label>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '1rem' }}>
            Real Salmonella surveillance runs from the AWS Open Data SRA bucket. Select one or more,
            then submit. These are the fastest path to a populated dashboard.
          </p>
          <div className="quick-pick-grid" role="group" aria-label="Curated isolates">
            {CURATED_ISOLATES.map((iso) => {
              const isSelected = selected.has(iso.accession);
              return (
                <button
                  key={iso.accession}
                  type="button"
                  className="quick-pick"
                  aria-pressed={isSelected}
                  onClick={() => toggleCurated(iso.accession)}
                  disabled={loading}
                  style={
                    isSelected
                      ? {
                          borderColor: 'var(--accent-primary)',
                          background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)',
                        }
                      : undefined
                  }
                >
                  <span className="quick-pick-acc gene-name">
                    {isSelected ? '\u2713 ' : ''}
                    {iso.accession}
                  </span>
                  <span className="quick-pick-label">{iso.label}</span>
                  <span className="quick-pick-source">{iso.source}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="card">
          <label htmlFor="accession-input">Custom accession list</label>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '1rem' }}>
            Enter public SRA run accessions separated by new lines, spaces, or commas. Each is
            checked below before you submit. Only public NCBI SRA data is accepted; controlled-access
            dbGaP accessions are rejected.
          </p>
          <textarea
            id="accession-input"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            rows={6}
            placeholder={'SRR1583085\nERR1234567\nDRR0000001'}
            aria-describedby="accession-help"
            spellCheck={false}
          />
          <p id="accession-help" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            Accepted formats: SRR, ERR, or DRR followed by digits (for example, SRR1583085).
          </p>

          {parsedCustom.length > 0 && (
            <ul
              aria-label="Parsed accessions"
              style={{ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', margin: 0, padding: 0 }}
            >
              {parsedCustom.map((p) => {
                const color = p.valid ? 'var(--accent-success)' : 'var(--accent-danger)';
                return (
                  <li
                    key={p.value}
                    className="gene-name"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.375rem',
                      padding: '0.25rem 0.625rem',
                      fontSize: '0.8125rem',
                      border: `1px solid ${color}`,
                      color,
                      background: `color-mix(in srgb, ${color} 12%, transparent)`,
                    }}
                    title={p.valid ? 'Valid accession format' : 'Not a valid SRR/ERR/DRR accession'}
                  >
                    <span aria-hidden="true">{p.valid ? '\u2713' : '\u2717'}</span>
                    {p.value}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Submit bar */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
            {submitList.length === 0 ? (
              mode === 'curated' ? 'Select at least one curated isolate.' : 'Enter at least one valid accession.'
            ) : (
              <>
                Ready to submit{' '}
                <span style={{ color: 'var(--accent-primary)' }}>{submitList.length}</span>{' '}
                {submitList.length === 1 ? 'isolate' : 'isolates'}.
              </>
            )}
            {invalidCount > 0 && (
              <span style={{ color: 'var(--accent-danger)', display: 'block', marginTop: '0.375rem' }}>
                {invalidCount} entry{invalidCount === 1 ? '' : 'ies'} in the list {invalidCount === 1 ? 'is' : 'are'} not a valid accession. Fix or remove {invalidCount === 1 ? 'it' : 'them'} to continue.
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn-trigger"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {loading ? 'Submitting...' : 'Trigger Ingestion'}
          </button>
        </div>

        {error && (
          <div className="error" id="ingestion-error" role="alert" style={{ marginTop: '1rem' }}>
            {error}
          </div>
        )}
      </div>

      <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        Need an accession? Browse{' '}
        <a href={SRA_BROWSER_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)' }}>
          public Salmonella WGS runs in the NCBI SRA
        </a>{' '}
        and copy a run accession from the results. Processing typically takes 30 to 90 minutes per
        sample depending on genome size.
      </p>
    </div>
  );
}
