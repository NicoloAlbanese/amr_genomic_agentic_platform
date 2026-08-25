"""
ingestion-validator Lambda
FR-020 / NFR-014: Validates SRA accession against public NCBI sources only.
Records source_provenance and license in DynamoDB and isolate_metadata.
"""
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

ALLOWED_SOURCES = set(os.environ.get("ALLOWED_SOURCES", "ncbi-sra-public,ncbi-trace-public").split(","))
DYNAMO_TABLE = os.environ.get("DYNAMO_TABLE_NAME", "")
REGION = os.environ.get("AWS_REGION", "us-west-2")

dynamo = boto3.client("dynamodb", region_name=REGION)

# SRA public accession patterns: SRR, ERR, DRR prefixes (public)
PUBLIC_ACCESSION_RE = re.compile(r"^(SRR|ERR|DRR|SRX|SRS|SRP|ERP|DRP)\d+$", re.IGNORECASE)
# Controlled-access patterns: dbGaP-protected projects
CONTROLLED_PATTERNS = [re.compile(p) for p in [
    r"^phs\d+",        # dbGaP study
    r"_controlled",    # explicit controlled marker
    r"_dbgap",         # dbGaP marker
]]


def log(level: str, msg: str, **kwargs) -> None:
    record = {
        "level": level,
        "message": msg,
        "run_id": kwargs.get("run_id", ""),
        "isolate_id": kwargs.get("isolate_id", ""),
        "stage": "ingestion-validator",
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    record.update(kwargs)
    print(json.dumps(record))


def is_controlled_access(accession: str, source: str) -> bool:
    """Return True if this accession or source indicates controlled access."""
    acc_lower = accession.lower()
    src_lower = source.lower()
    for pattern in CONTROLLED_PATTERNS:
        if pattern.search(acc_lower) or pattern.search(src_lower):
            return True
    return False


def resolve_source_and_license(accession: str, source: str):
    """
    Determine source_provenance and license from accession and source hint.
    For public NCBI SRA data, all WGS data is US Government public domain.
    """
    source_map = {
        "ncbi-sra-public": {
            "source_provenance": "NCBI SRA Public",
            "license": "US Government public domain (NCBI SRA)",
        },
        "ncbi-trace-public": {
            "source_provenance": "NCBI Trace Archive Public",
            "license": "US Government public domain (NCBI Trace)",
        },
    }
    src_key = source.lower().strip()
    if src_key in source_map:
        return source_map[src_key]
    # Default for any other public NCBI source
    return {
        "source_provenance": f"NCBI SRA Public ({source})",
        "license": "US Government public domain (NCBI SRA)",
    }


def record_to_dynamo(isolate_id: str, accession: str, source_provenance: str, license_str: str, run_id: str) -> None:
    """Write provenance record to DynamoDB. Non-fatal on failure."""
    if not DYNAMO_TABLE:
        log("warn", "DYNAMO_TABLE_NAME not set, skipping DynamoDB write", run_id=run_id, isolate_id=isolate_id)
        return
    try:
        event_ts = datetime.now(timezone.utc).isoformat()
        dynamo.put_item(
            TableName=DYNAMO_TABLE,
            Item={
                "isolate_id":        {"S": isolate_id},
                "event_ts":          {"S": event_ts},
                "run_id":            {"S": run_id},
                "stage":             {"S": "ingestion-validator"},
                "accession":         {"S": accession},
                "source_provenance": {"S": source_provenance},
                "license":           {"S": license_str},
                "status":            {"S": "VALIDATED"},
            },
        )
        log("info", "DynamoDB provenance record written", run_id=run_id, isolate_id=isolate_id)
    except Exception as e:
        log("error", f"DynamoDB write failed (non-fatal): {e}", run_id=run_id, isolate_id=isolate_id)


def handler(event: dict, context) -> dict:
    """
    Expected event shape (single isolate):
    {
        "isolate_id": "ISO-001",
        "accession": "SRR123456",
        "source": "ncbi-sra-public",   # optional, defaults to ncbi-sra-public
        "run_id": "run-2024-01-01"
    }
    Returns enriched dict with source_provenance and license, or raises ValueError.
    """
    isolate_id = event.get("isolate_id", str(uuid.uuid4()))
    accession = event.get("accession", "").strip()
    source = event.get("source", "ncbi-sra-public").strip()
    run_id = event.get("run_id", "")

    log("info", "ingestion-validator invoked", run_id=run_id, isolate_id=isolate_id,
        accession=accession, source=source)

    # --- Validation: controlled access check ---
    if is_controlled_access(accession, source):
        log("warn", "REJECTED: controlled-access source detected",
            run_id=run_id, isolate_id=isolate_id, accession=accession, source=source)
        raise ValueError(
            f"Controlled-access source rejected: accession={accession} source={source}. "
            "Only public NCBI SRA data is permitted."
        )

    # --- Validation: source allow-list ---
    if source not in ALLOWED_SOURCES:
        log("warn", "REJECTED: source not in allow-list",
            run_id=run_id, isolate_id=isolate_id, source=source, allowed=list(ALLOWED_SOURCES))
        raise ValueError(
            f"Source '{source}' not in allowed sources: {sorted(ALLOWED_SOURCES)}. "
            "Only public NCBI SRA sources are permitted."
        )

    # --- Validation: accession format ---
    if not PUBLIC_ACCESSION_RE.match(accession):
        log("warn", "REJECTED: accession format invalid",
            run_id=run_id, isolate_id=isolate_id, accession=accession)
        raise ValueError(
            f"Accession '{accession}' does not match expected public SRA format. "
            "Expected SRR/ERR/DRR/SRX/SRS/SRP/ERP/DRP prefix."
        )

    # --- Resolve provenance ---
    provenance = resolve_source_and_license(accession, source)
    source_provenance = provenance["source_provenance"]
    license_str = provenance["license"]

    log("info", "Validation passed", run_id=run_id, isolate_id=isolate_id,
        source_provenance=source_provenance, license=license_str)

    # --- Record to DynamoDB ---
    record_to_dynamo(isolate_id, accession, source_provenance, license_str, run_id)

    # --- Return enriched event ---
    return {
        **event,
        "isolate_id": isolate_id,
        "accession": accession,
        "source": source,
        "source_provenance": source_provenance,
        "license": license_str,
        "validated": True,
    }
