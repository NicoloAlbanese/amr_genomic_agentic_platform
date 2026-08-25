/**
 * GET /isolates
 * Returns one row per isolate from the Athena isolate_metadata table, enriched
 * with the AMR genes detected for that isolate (LEFT JOIN amr_profiles). An
 * optional organism filter narrows the result set. Genes are surfaced as a
 * string array so the dashboard can chart gene frequency without a second call.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';

const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });

const ATHENA_DATABASE = process.env.ATHENA_DATABASE!;
const ATHENA_CATALOG = process.env.ATHENA_CATALOG ?? 'AwsDataCatalog';
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP!;
const ATHENA_RESULTS_BUCKET = process.env.ATHENA_RESULTS_BUCKET!;

// Fully-qualified, quoted "catalog"."database". prefix so the query resolves the
// S3 Tables federated catalog regardless of the default catalog.
const TABLE_PREFIX = `"${ATHENA_CATALOG}"."${ATHENA_DATABASE}".`;

function corsHeaders() {
  const origin = process.env.CLOUDFRONT_URL
    ? `https://${process.env.CLOUDFRONT_URL}`
    : '*';
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

async function runAthenaQuery(sql: string): Promise<unknown[]> {
  // ResultConfiguration is intentionally omitted: the workgroup enforces
  // EnforceWorkGroupConfiguration=true with SSE_KMS, so the workgroup's
  // output location and encryption settings apply automatically.
  const startResp = await athenaClient.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      QueryExecutionContext: { Database: ATHENA_DATABASE, Catalog: ATHENA_CATALOG },
      WorkGroup: ATHENA_WORKGROUP,
    }),
  );

  const queryExecutionId = startResp.QueryExecutionId!;

  // Poll up to 25s
  for (let i = 0; i < 25; i++) {
    const execResp = await athenaClient.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }),
    );
    const state = execResp.QueryExecution?.Status?.State;
    if (state === QueryExecutionState.SUCCEEDED) break;
    if (state === QueryExecutionState.FAILED || state === QueryExecutionState.CANCELLED) {
      throw new Error(`Athena query ${state}: ${execResp.QueryExecution?.Status?.StateChangeReason}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const resultsResp = await athenaClient.send(
    new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId, MaxResults: 200 }),
  );

  const rows = resultsResp.ResultSet?.Rows ?? [];
  if (rows.length < 2) return [];

  const headers = rows[0].Data?.map((d) => d.VarCharValue ?? '') ?? [];
  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    row.Data?.forEach((d, i) => {
      obj[headers[i]] = d.VarCharValue ?? '';
    });
    return obj;
  });
}

interface IsolateRow {
  isolateId: string;
  organism: string;
  sraAccession: string;
  sourceProvenance: string;
  license: string;
  ingestionTs: string;
  amrGenes: string[];
}

/**
 * One row per isolate with its detected AMR genes aggregated from amr_profiles.
 * A LEFT JOIN keeps isolates that have no gene hits yet (genes -> empty array).
 * gene_name is preferred for readability; gene_id is the fallback so a hit is
 * never dropped when a name is missing.
 */
function buildIsolatesSql(organism?: string): string {
  const where = organism
    ? `WHERE LOWER(m.organism) = LOWER('${organism.replace(/[^a-zA-Z0-9 _-]/g, '')}')`
    : '';
  return `
    SELECT
      m.isolate_id AS isolate_id,
      MAX(m.organism) AS organism,
      MAX(m.sra_accession) AS sra_accession,
      MAX(m.source_provenance) AS source_provenance,
      MAX(m.license) AS license,
      MAX(CAST(m.ingestion_ts AS VARCHAR)) AS ingestion_ts,
      array_join(
        array_agg(DISTINCT COALESCE(NULLIF(p.gene_name, ''), p.gene_id))
          FILTER (WHERE p.gene_id IS NOT NULL),
        ','
      ) AS genes
    FROM ${TABLE_PREFIX}isolate_metadata m
    LEFT JOIN ${TABLE_PREFIX}amr_profiles p ON m.isolate_id = p.isolate_id
    ${where}
    GROUP BY m.isolate_id
    ORDER BY m.isolate_id
    LIMIT 100
  `;
}

function toIsolate(row: Record<string, string>): IsolateRow {
  const genes = (row.genes ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
  return {
    isolateId: row.isolate_id ?? '',
    organism: row.organism ?? '',
    sraAccession: row.sra_accession ?? '',
    sourceProvenance: row.source_provenance ?? '',
    license: row.license ?? '',
    ingestionTs: row.ingestion_ts ?? '',
    amrGenes: genes,
  };
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const organism = event.queryStringParameters?.organism;
  console.log(JSON.stringify({ level: 'INFO', message: 'isolates invoked', organism }));

  try {
    const rows = (await runAthenaQuery(buildIsolatesSql(organism))) as Record<string, string>[];
    const isolates = rows.map(toIsolate);
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ isolates, count: isolates.length }),
    };
  } catch (err) {
    console.error(JSON.stringify({ level: 'ERROR', message: 'isolates query failed', error: String(err) }));
    return {
      statusCode: 502,
      headers: corsHeaders(),
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
