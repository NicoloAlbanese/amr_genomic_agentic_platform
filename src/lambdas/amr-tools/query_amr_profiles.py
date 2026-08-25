"""
query_amr_profiles Lambda tool
Queries amr_profiles Iceberg table by organism and optional date range.
Returns JSON with gene_id, tool_name, confidence fields for grounding citations.
"""
import json
import logging
import os
import re
import time
import boto3

_SAFE_IDENT_RE = re.compile(r"^[A-Za-z0-9\s\-_.]+$")


def _validate_ident(value: str, field: str) -> str:
    if not value:
        return value
    if not _SAFE_IDENT_RE.match(value):
        raise ValueError(f"Invalid characters in {field}: {value!r}")
    if len(value) > 100:
        raise ValueError(f"{field} too long (max 100 chars)")
    return value

logger = logging.getLogger()
logger.setLevel(logging.INFO)

ATHENA_DATABASE = os.environ.get("ATHENA_DATABASE", "amr_db")
ATHENA_CATALOG = os.environ.get("ATHENA_CATALOG", "AwsDataCatalog")
ATHENA_WORKGROUP = os.environ.get("ATHENA_WORKGROUP", "primary")
ATHENA_RESULTS_BUCKET = os.environ.get("ATHENA_RESULTS_BUCKET", "")
REGION = os.environ.get("AWS_REGION", "us-west-2")

athena = boto3.client("athena", region_name=REGION)

# Fully-qualified, quoted table prefix: "catalog"."database".
# The Lambda runtime's bundled boto3 may not send QueryExecutionContext.Catalog
# (that field was added to the Athena API later), so it silently defaults to
# awsdatacatalog and the federated S3 Tables catalog is never used. Qualifying
# the table name in the SQL itself is version-independent and unambiguous. The
# resource prefix contains a hyphen, so both identifiers must be double-quoted.
TABLE_PREFIX = f'"{ATHENA_CATALOG}"."{ATHENA_DATABASE}".'


def _run_query(sql: str, max_results: int = 50) -> list[dict]:
    """Execute an Athena query and return rows as list of dicts."""
    if not ATHENA_RESULTS_BUCKET:
        raise ValueError("ATHENA_RESULTS_BUCKET env var is not set")
    response = athena.start_query_execution(
        QueryString=sql,
        QueryExecutionContext={"Database": ATHENA_DATABASE, "Catalog": ATHENA_CATALOG},
        WorkGroup=ATHENA_WORKGROUP,
        ResultConfiguration={"OutputLocation": f"s3://{ATHENA_RESULTS_BUCKET}/tool-queries/"},
    )
    exec_id = response["QueryExecutionId"]

    # Poll until complete (max 30s for tool round-trip target)
    for _ in range(30):
        status = athena.get_query_execution(QueryExecutionId=exec_id)
        state = status["QueryExecution"]["Status"]["State"]
        if state == "SUCCEEDED":
            break
        if state in ("FAILED", "CANCELLED"):
            reason = status["QueryExecution"]["Status"].get("StateChangeReason", "Unknown")
            raise RuntimeError(f"Athena query {state}: {reason}")
        time.sleep(1)
    else:
        raise TimeoutError("Athena query timed out after 30s")

    results = athena.get_query_results(QueryExecutionId=exec_id, MaxResults=max_results + 1)
    rows = results["ResultSet"]["Rows"]
    if len(rows) <= 1:
        return []

    headers = [c["VarCharValue"] for c in rows[0]["Data"]]
    return [
        {headers[i]: col.get("VarCharValue", "") for i, col in enumerate(row["Data"])}
        for row in rows[1:]
    ]


def handler(event, context):
    """
    Input: { organism: str, date_from?: str (YYYY-MM-DD), date_to?: str, limit?: int }
    Output: { results: [...], tool_name: "query_amr_profiles", count: int }
    """
    try:
        body = event if isinstance(event, dict) else json.loads(event.get("body", "{}"))
        organism = _validate_ident(body.get("organism", "").strip(), "organism")
        date_from = body.get("date_from", "")
        date_to = body.get("date_to", "")
        limit = min(int(body.get("limit", 20)), 50)

        if not organism:
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "organism parameter required", "tool_name": "query_amr_profiles"}),
            }

        # Build WHERE clause — always scope by organism to keep result-row count
        # bounded. The amr_profiles Iceberg schema is:
        #   isolate_id, gene_id, gene_name, detection_tool, confidence,
        #   organism, run_id, ts (timestamp)
        where_clauses = [f"LOWER(organism) LIKE LOWER('%{organism}%')"]
        if date_from:
            where_clauses.append(f"ts >= TIMESTAMP '{date_from} 00:00:00'")
        if date_to:
            where_clauses.append(f"ts <= TIMESTAMP '{date_to} 23:59:59'")

        where_sql = " AND ".join(where_clauses)

        sql = f"""
        SELECT
            isolate_id,
            organism,
            gene_id,
            gene_name,
            detection_tool,
            CAST(confidence AS VARCHAR) AS confidence,
            run_id,
            CAST(ts AS VARCHAR) AS ts
        FROM {TABLE_PREFIX}amr_profiles
        WHERE {where_sql}
        ORDER BY ts DESC
        LIMIT {limit}
        """

        rows = _run_query(sql, max_results=limit)

        # Ensure required citation fields are present. tool_name maps to the
        # detection tool that called the gene (e.g. AMRFinderPlus).
        results = []
        for row in rows:
            results.append({
                "isolate_id": row.get("isolate_id", ""),
                "organism": row.get("organism", ""),
                "gene_id": row.get("gene_id", ""),
                "gene_name": row.get("gene_name", ""),
                "tool_name": row.get("detection_tool", "amrfinderplus"),
                "confidence": row.get("confidence", ""),
                "analysis_date": row.get("ts", ""),
            })

        logger.info(
            json.dumps({
                "level": "INFO",
                "tool": "query_amr_profiles",
                "organism": organism,
                "result_count": len(results),
            })
        )

        return {
            "statusCode": 200,
            "body": json.dumps({
                "results": results,
                "tool_name": "query_amr_profiles",
                "count": len(results),
                "organism": organism,
            }),
        }

    except Exception as exc:
        logger.error(json.dumps({"level": "ERROR", "tool": "query_amr_profiles", "error": str(exc)}))
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(exc), "tool_name": "query_amr_profiles", "results": []}),
        }
