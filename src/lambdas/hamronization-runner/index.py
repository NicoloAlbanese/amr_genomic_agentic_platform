"""
hamronization-runner Lambda — FR-005
Reads multi-tool AMR TSVs from S3 and emits hAMRonization-compliant TSV.
"""
import csv
import io
import json
import os
from datetime import datetime, timezone

import boto3

REGION = os.environ.get("AWS_REGION", "us-west-2")
DATA_LAKE_BUCKET = os.environ.get("DATA_LAKE_BUCKET", "")

s3 = boto3.client("s3", region_name=REGION)

HAMRONIZATION_FIELDS = [
    "input_file_name", "gene_symbol", "gene_name", "reference_database_id",
    "reference_database_version", "reference_accession", "sequence_identity",
    "reference_length", "coverage_depth", "coverage_percentage", "drug_class",
    "antimicrobial_agent", "resistance_mechanism", "input_sequence_id",
    "input_gene_start", "input_gene_stop", "strand_orientation",
    "input_protein_length", "input_protein_start", "input_protein_stop",
    "analysis_software_name", "analysis_software_version", "reference_file_path",
]

TOOL_FIELD_MAPS = {
    # AMRFinderPlus 4.x column headers (differ from the pre-4.x names).
    "amrfinderplus": {
        "Element symbol": "gene_symbol",
        "Element name": "gene_name",
        "Protein id": "input_sequence_id",
        "Contig id": "input_sequence_id",
        "% Coverage of reference": "coverage_percentage",
        "% Identity to reference": "sequence_identity",
        "Alignment length": "reference_length",
        "Closest reference accession": "reference_accession",
        "Class": "drug_class",
        "Subclass": "antimicrobial_agent",
        "Method": "resistance_mechanism",
        "Start": "input_gene_start",
        "Stop": "input_gene_stop",
        "Strand": "strand_orientation",
    },
    "rgi": {
        "ORF_ID": "input_sequence_id",
        "Best_Hit_ARO": "gene_symbol",
        "Best_Identities": "sequence_identity",
        "ARO": "reference_accession",
        "Drug Class": "drug_class",
        "Resistance Mechanism": "resistance_mechanism",
        "AMR Gene Family": "gene_name",
        "Start": "input_gene_start",
        "Stop": "input_gene_stop",
        "Orientation": "strand_orientation",
        "Best_Hit_Bitscore": "coverage_depth",
    },
    "resfinder": {
        "Resistance gene": "gene_symbol",
        "Identity": "sequence_identity",
        "Alignment Length/Gene Length": "reference_length",
        "Coverage": "coverage_percentage",
        "Position in contig": "input_gene_start",
        "Contig": "input_sequence_id",
        "Phenotype": "drug_class",
        "Accession no.": "reference_accession",
    },
    "fargene": {
        "hmm": "reference_accession",
        "orf": "input_sequence_id",
        "hmm_score": "coverage_depth",
        "class": "drug_class",
    },
}


def emit_log(level, msg, **kwargs):
    record = {
        "level": level,
        "message": msg,
        "stage": "hamronization-runner",
        "ts": datetime.now(timezone.utc).isoformat(),
    }
    record.update(kwargs)
    print(json.dumps(record))


def detect_tool(headers):
    lower = set(h.lower() for h in headers)
    if "best_hit_aro" in lower or "best_identities" in lower:
        return "rgi"
    # AMRFinderPlus 4.x uses "Element symbol"/"Element name"; older versions used
    # "Gene symbol"/"Protein identifier". Accept both.
    if "element symbol" in lower or "gene symbol" in lower or "protein identifier" in lower:
        return "amrfinderplus"
    if "resistance gene" in lower or "phenotype" in lower:
        return "resfinder"
    if "hmm" in lower and "orf" in lower:
        return "fargene"
    return "unknown"


def map_row(row, tool, input_file):
    field_map = TOOL_FIELD_MAPS.get(tool, {})
    harmonized = {f: "" for f in HAMRONIZATION_FIELDS}
    harmonized["input_file_name"] = input_file
    harmonized["analysis_software_name"] = tool
    for src, val in row.items():
        tgt = field_map.get(src)
        if tgt and tgt in harmonized:
            harmonized[tgt] = val
    if not harmonized.get("gene_name") and harmonized.get("gene_symbol"):
        harmonized["gene_name"] = harmonized["gene_symbol"]
    strand = harmonized.get("strand_orientation", "")
    if strand in ("+", "1", "sense", "forward"):
        harmonized["strand_orientation"] = "+"
    elif strand in ("-", "-1", "antisense", "reverse"):
        harmonized["strand_orientation"] = "-"
    return harmonized


def read_tsv_from_s3(bucket, key):
    try:
        resp = s3.get_object(Bucket=bucket, Key=key)
        content = resp["Body"].read().decode("utf-8")
        reader = csv.DictReader(io.StringIO(content), delimiter="\t")
        rows = list(reader)
        headers = list(reader.fieldnames or [])
        return headers, rows
    except Exception as exc:
        raise RuntimeError(f"Failed to read s3://{bucket}/{key}: {exc}") from exc


def write_tsv_to_s3(bucket, key, rows):
    try:
        output = io.StringIO()
        writer = csv.DictWriter(
            output, fieldnames=HAMRONIZATION_FIELDS,
            delimiter="\t", extrasaction="ignore", lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(rows)
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=output.getvalue().encode("utf-8"),
            ContentType="text/tab-separated-values",
        )
    except Exception as exc:
        raise RuntimeError(f"Failed to write s3://{bucket}/{key}: {exc}") from exc


def discover_amr_keys(bucket, prefix):
    """
    List every object under an S3 prefix and return the keys of AMRFinderPlus
    result TSVs. HealthOmics exports Nextflow publishDir content to a run-scoped
    subpath whose exact shape is not contractually fixed, so we discover the TSV
    by suffix under the run's output prefix rather than hardcoding the path.
    """
    keys = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith("amrfinderplus.tsv") and obj.get("Size", 0) > 0:
                keys.append(key)
    return keys


def handler(event, context):
    isolate_id = event.get("isolate_id", "")
    run_id = event.get("run_id", "")
    amr_result_keys = event.get("amr_result_keys", [])
    amr_output_prefix = event.get("amr_output_prefix", "")
    bucket = event.get("data_lake_bucket") or DATA_LAKE_BUCKET

    # Preferred path: discover the AMRFinderPlus TSV under the HealthOmics run
    # output prefix. Fall back to explicit keys if provided (kept for tests).
    if not amr_result_keys and amr_output_prefix:
        amr_result_keys = discover_amr_keys(bucket, amr_output_prefix)
        emit_log("info", "Discovered AMR result keys under prefix",
                 run_id=run_id, isolate_id=isolate_id,
                 prefix=amr_output_prefix, discovered=len(amr_result_keys))

    emit_log("info", "hamronization-runner invoked",
             run_id=run_id, isolate_id=isolate_id,
             input_count=len(amr_result_keys))

    if not amr_result_keys:
        emit_log("warn", "No AMR result keys found", run_id=run_id, isolate_id=isolate_id)
        return {**event, "harmonized_key": None, "harmonized_rows": 0}

    all_harmonized = []

    for key in amr_result_keys:
        try:
            headers, rows = read_tsv_from_s3(bucket, key)
            tool = detect_tool(headers)
            emit_log("info", f"Processing {key}",
                     run_id=run_id, isolate_id=isolate_id,
                     tool=tool, row_count=len(rows))
            for row in rows:
                # AMRFinderPlus reports AMR, VIRULENCE, and STRESS elements in one
                # TSV (the "Type" column). Keep only AMR elements for the AMR
                # resistance store; other types would pollute amr_profiles.
                if tool == "amrfinderplus":
                    row_type = (row.get("Type") or "").strip().upper()
                    if row_type and row_type != "AMR":
                        continue
                all_harmonized.append(map_row(row, tool, key))
        except Exception as exc:
            emit_log("warn", f"Skipping {key}: {exc}",
                     run_id=run_id, isolate_id=isolate_id)

    output_key = f"harmonized/{isolate_id}/{run_id}/hamronization.tsv"
    write_tsv_to_s3(bucket, output_key, all_harmonized)

    emit_log("info", "hAMRonization TSV written",
             run_id=run_id, isolate_id=isolate_id,
             output_key=output_key, rows=len(all_harmonized))

    return {
        **event,
        "harmonized_key": output_key,
        "harmonized_bucket": bucket,
        "harmonized_rows": len(all_harmonized),
    }
