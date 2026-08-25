"""
compare_isolates Lambda tool
Joins isolate_metadata with amr_profiles to compare resistance profiles across isolates.
Returns JSON with gene_id, tool_name, confidence fields for grounding citations.
"""
import json
import logging
import os
import re
import time
import boto3

_SAFE_IDENT_RE = re.compile(r"^[A-Za-z0-9\s\-_.]+$")
_SAFE_ISOLATE_RE = re.compile(r"^[A-Za-z0-9\-_.]+$")


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
# Fully-qualified, quoted "catalog"."database". prefix — the Lambda boto3 may not
# send QueryExecutionContext.Catalog, so qualify the table in SQL instead.
TABLE_PREFIX = f'"{ATHENA_CATALOG}"."{ATHENA_DATABASE}".'
REGION = os.environ.get("AWS_REGION", "us-west-2")

athena = boto3.client("athena", region_name=REGION)


def _run_query(sql: str, max_results: int = 50) -> list[dict]:
    if not ATHENA_RESULTS_BUCKET:
        raise ValueError("ATHENA_RESULTS_BUCKET env var is not set")
    response = athena.start_query_execution(
        QueryString=sql,
        QueryExecutionContext={"Database": ATHENA_DATABASE, "Catalog": ATHENA_CATALOG},
        WorkGroup=ATHENA_WORKGROUP,
        ResultConfiguration={"OutputLocation": f"s3://{ATHENA_RESULTS_BUCKET}/tool-queries/"},
    )
    exec_id = response["QueryExecutionId"]

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
    Input: { isolate_ids?: list[str], organism?: str, limit?: int }
    Output: { comparisons: [...], tool_name: "compare_isolates", gene_id, confidence }
    """
    try:
        body = event if isinstance(event, dict) else json.loads(event.get("body", "{}"))
        isolate_ids = body.get("isolate_ids", [])
        organism = _validate_ident(body.get("organism", "").strip(), "organism")
        limit = min(int(body.get("limit", 20)), 50)

        where_clauses = []

        if isolate_ids and isinstance(isolate_ids, list):
            # Validate isolate IDs — allow only alphanumeric, dash, underscore, dot
            safe_ids = [
                iid
                for iid in isolate_ids[:10]
                if isinstance(iid, str) and _SAFE_ISOLATE_RE.match(iid) and len(iid) <= 100
            ]
            if safe_ids:
                id_list = ", ".join(f"'{iid}'" for iid in safe_ids)
                where_clauses.append(f"ap.isolate_id IN ({id_list})")

        if organism:
            where_clauses.append(f"LOWER(ap.organism) LIKE LOWER('%{organism}%')")

        if not where_clauses:
            # Require at least one filter to prevent full-table scan
            return {
                "statusCode": 400,
                "body": json.dumps({
                    "error": "Provide isolate_ids or organism filter",
                    "tool_name": "compare_isolates",
                }),
            }

        where_sql = " AND ".join(where_clauses)

        # Schemas:
        #   amr_profiles: isolate_id, gene_id, gene_name, detection_tool,
        #                 confidence, organism, run_id, ts
        #   isolate_metadata: isolate_id, organism, sra_accession,
        #                     source_provenance, license, ingestion_ts
        sql = f"""
        SELECT
            ap.isolate_id,
            ap.organism,
            ap.gene_id,
            ap.gene_name,
            ap.detection_tool,
            CAST(ap.confidence AS VARCHAR) AS confidence,
            CAST(ap.ts AS VARCHAR) AS analysis_date,
            im.sra_accession,
            im.source_provenance,
            CAST(im.ingestion_ts AS VARCHAR) AS ingestion_ts
        FROM {TABLE_PREFIX}amr_profiles ap
        LEFT JOIN {TABLE_PREFIX}isolate_metadata im
            ON ap.isolate_id = im.isolate_id
        WHERE {where_sql}
        ORDER BY ap.gene_id, ap.isolate_id
        LIMIT {limit}
        """

        rows = _run_query(sql, max_results=limit)

        comparisons = []
        for row in rows:
            comparisons.append({
                "isolate_id": row.get("isolate_id", ""),
                "organism": row.get("organism", ""),
                "gene_id": row.get("gene_id", ""),
                "gene_name": row.get("gene_name", ""),
                "tool_name": row.get("detection_tool", "amrfinderplus"),
                "confidence": row.get("confidence", ""),
                "analysis_date": row.get("analysis_date", ""),
                "sra_accession": row.get("sra_accession", ""),
                "source_provenance": row.get("source_provenance", ""),
                "ingestion_ts": row.get("ingestion_ts", ""),
            })

        # Representative gene_id and confidence for citation
        top_gene = comparisons[0]["gene_id"] if comparisons else ""
        top_conf = comparisons[0]["confidence"] if comparisons else "0"

        logger.info(
            json.dumps({
                "level": "INFO",
                "tool": "compare_isolates",
                "organism": organism,
                "isolate_ids_requested": len(isolate_ids),
                "result_count": len(comparisons),
            })
        )

        return {
            "statusCode": 200,
            "body": json.dumps({
                "comparisons": comparisons,
                "tool_name": "compare_isolates",
                "gene_id": top_gene,
                "confidence": top_conf,
                "count": len(comparisons),
            }),
        }

    except Exception as exc:
        logger.error(json.dumps({"level": "ERROR", "tool": "compare_isolates", "error": str(exc)}))
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(exc), "tool_name": "compare_isolates", "comparisons": []}),
        }
