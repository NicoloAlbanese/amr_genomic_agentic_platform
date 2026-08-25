"""
get_resistance_trends Lambda tool
Performs windowed monthly aggregation on amr_profiles to show resistance trends.
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
# Fully-qualified, quoted "catalog"."database". prefix — the Lambda boto3 may not
# send QueryExecutionContext.Catalog, so qualify the table in SQL instead.
TABLE_PREFIX = f'"{ATHENA_CATALOG}"."{ATHENA_DATABASE}".'
REGION = os.environ.get("AWS_REGION", "us-west-2")

athena = boto3.client("athena", region_name=REGION)


def _run_query(sql: str, max_results: int = 100) -> list[dict]:
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
    Input: { gene_id?: str, resistance_class?: str, months?: int (default 12) }
    Output: { trends: [...], tool_name: "get_resistance_trends", gene_id, confidence }
    """
    try:
        body = event if isinstance(event, dict) else json.loads(event.get("body", "{}"))
        gene_id = _validate_ident(body.get("gene_id", "").strip(), "gene_id")
        resistance_class = _validate_ident(body.get("resistance_class", "").strip(), "resistance_class")
        months = min(int(body.get("months", 12)), 24)

        # amr_profiles schema: isolate_id, gene_id, gene_name, detection_tool,
        # confidence, organism, run_id, ts. There is no resistance_class column,
        # so resistance_class narrows by gene_name as a best-effort proxy.
        where_clauses = [f"ts >= DATE_ADD('month', -{months}, CURRENT_DATE)"]
        if gene_id:
            where_clauses.append(f"LOWER(gene_id) LIKE LOWER('%{gene_id}%')")
        if resistance_class:
            where_clauses.append(
                f"LOWER(gene_name) LIKE LOWER('%{resistance_class}%')"
            )

        where_sql = " AND ".join(where_clauses)

        # Window query: monthly counts with running total per gene
        sql = f"""
        WITH monthly AS (
            SELECT
                DATE_FORMAT(ts, '%Y-%m') AS month,
                gene_id,
                detection_tool,
                AVG(CAST(confidence AS DOUBLE)) AS avg_confidence,
                COUNT(*) AS detection_count,
                COUNT(DISTINCT organism) AS organism_count
            FROM {TABLE_PREFIX}amr_profiles
            WHERE {where_sql}
            GROUP BY DATE_FORMAT(ts, '%Y-%m'), gene_id, detection_tool
        )
        SELECT
            month,
            gene_id,
            detection_tool,
            CAST(ROUND(avg_confidence, 4) AS VARCHAR) AS confidence,
            CAST(detection_count AS VARCHAR) AS detection_count,
            CAST(organism_count AS VARCHAR) AS organism_count,
            CAST(SUM(detection_count) OVER (
                PARTITION BY gene_id ORDER BY month
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS VARCHAR) AS cumulative_detections
        FROM monthly
        ORDER BY gene_id, month DESC
        LIMIT 100
        """

        rows = _run_query(sql, max_results=100)

        trends = []
        for row in rows:
            trends.append({
                "month": row.get("month", ""),
                "gene_id": row.get("gene_id", ""),
                "tool_name": row.get("detection_tool", "amrfinderplus"),
                "confidence": row.get("confidence", ""),
                "detection_count": row.get("detection_count", "0"),
                "organism_count": row.get("organism_count", "0"),
                "cumulative_detections": row.get("cumulative_detections", "0"),
            })

        logger.info(
            json.dumps({
                "level": "INFO",
                "tool": "get_resistance_trends",
                "gene_id": gene_id,
                "resistance_class": resistance_class,
                "result_count": len(trends),
            })
        )

        return {
            "statusCode": 200,
            "body": json.dumps({
                "trends": trends,
                "tool_name": "get_resistance_trends",
                "gene_id": gene_id or "all",
                "confidence": trends[0]["confidence"] if trends else "0",
                "count": len(trends),
            }),
        }

    except Exception as exc:
        logger.error(json.dumps({"level": "ERROR", "tool": "get_resistance_trends", "error": str(exc)}))
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(exc), "tool_name": "get_resistance_trends", "trends": []}),
        }
