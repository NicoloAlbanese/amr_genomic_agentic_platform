"""
isolate-deduper Lambda
FR-001 / FR-010: DynamoDB conditional write to deduplicate isolate accessions.
Uses attribute_not_exists(isolate_id) condition to skip already-processed isolates.
"""
import json
import logging
import os
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

DYNAMO_TABLE = os.environ.get("DYNAMO_TABLE_NAME", "")
REGION = os.environ.get("AWS_REGION", "us-west-2")

dynamo = boto3.client("dynamodb", region_name=REGION)


def log(level: str, msg: str, **kwargs) -> None:
    record = {
        "level": level,
        "message": msg,
        "run_id": kwargs.get("run_id", ""),
        "isolate_id": kwargs.get("isolate_id", ""),
        "stage": "isolate-deduper",
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    record.update(kwargs)
    print(json.dumps(record))


def handler(event: dict, context) -> dict:
    """
    Expected event shape:
    {
        "isolate_id": "ISO-001",
        "accession": "SRR123456",
        "source_provenance": "NCBI SRA Public",
        "license": "...",
        "run_id": "run-2024-01-01",
        ...
    }
    Returns event enriched with:
        "is_duplicate": bool
        "skipped": bool  (True if duplicate, skip downstream processing)
    """
    isolate_id = event.get("isolate_id", "")
    accession = event.get("accession", "")
    run_id = event.get("run_id", "")
    source_provenance = event.get("source_provenance", "")
    license_str = event.get("license", "")

    log("info", "isolate-deduper invoked", run_id=run_id, isolate_id=isolate_id, accession=accession)

    if not DYNAMO_TABLE:
        log("warn", "DYNAMO_TABLE_NAME not set, skipping deduplication", run_id=run_id, isolate_id=isolate_id)
        return {**event, "is_duplicate": False, "skipped": False}

    event_ts = datetime.now(timezone.utc).isoformat()

    try:
        # Conditional write: only succeed if isolate_id does NOT exist as a PENDING/PROCESSING record
        # We use a separate sentinel item with sort key "STATUS" for deduplication tracking
        dynamo.put_item(
            TableName=DYNAMO_TABLE,
            Item={
                "isolate_id":        {"S": isolate_id},
                "event_ts":          {"S": f"STATUS#{run_id}"},
                "run_id":            {"S": run_id},
                "stage":             {"S": "isolate-deduper"},
                "accession":         {"S": accession},
                "source_provenance": {"S": source_provenance},
                "license":           {"S": license_str},
                "status":            {"S": "PENDING"},
                "created_ts":        {"S": event_ts},
            },
            # Only insert if this isolate_id + run combination doesn't already exist
            ConditionExpression="attribute_not_exists(isolate_id) OR attribute_not_exists(#et)",
            ExpressionAttributeNames={"#et": "event_ts"},
        )
        log("info", "New isolate: will process", run_id=run_id, isolate_id=isolate_id)
        return {**event, "is_duplicate": False, "skipped": False}

    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            log("info", "Duplicate isolate detected, skipping",
                run_id=run_id, isolate_id=isolate_id, accession=accession)
            return {**event, "is_duplicate": True, "skipped": True}
        # Unexpected DynamoDB error — re-raise so Step Functions Catch can handle
        log("error", f"DynamoDB error: {e}", run_id=run_id, isolate_id=isolate_id)
        raise
