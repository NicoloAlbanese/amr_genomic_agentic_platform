"""
amr-etl Glue PySpark Job — FR-006
GlueVersion=5.0, WorkerType=G.1X, Spark engine (NOT Ray).
MERGE INTO Iceberg tables: amr_profiles, isolate_metadata.
Idempotent: ON isolate_id+gene_id prevents duplicates.
"""
import sys
import json
import logging
from datetime import datetime, timezone

from awsglue.context import GlueContext
from awsglue.job import Job
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from pyspark.sql import functions as F
from pyspark.sql.types import (
    StringType, DoubleType, TimestampType, StructType, StructField
)

logging.basicConfig(level=logging.INFO)


def emit_log(level, msg, **kwargs):
    record = {"level": level, "message": msg, "stage": "amr-etl",
              "ts": datetime.now(timezone.utc).isoformat()}
    record.update(kwargs)
    print(json.dumps(record))


args = getResolvedOptions(sys.argv, [
    "JOB_NAME", "harmonized_key", "harmonized_bucket",
    "isolate_id", "run_id", "glue_catalog_db", "data_lake_bucket",
    "organism", "sra_accession", "source_provenance", "license",
])

JOB_NAME = args["JOB_NAME"]
HARMONIZED_KEY = args["harmonized_key"]
HARMONIZED_BUCKET = args["harmonized_bucket"]
ISOLATE_ID = args["isolate_id"]
RUN_ID = args["run_id"]
GLUE_CATALOG_DB = args["glue_catalog_db"]
DATA_LAKE_BUCKET = args["data_lake_bucket"]
ORGANISM = args["organism"]
SRA_ACCESSION = args["sra_accession"]
SOURCE_PROVENANCE = args["source_provenance"]
LICENSE = args["license"]


def sql_str(value):
    """Render a Python string as a SQL string literal, escaping single quotes."""
    return "'" + str(value).replace("'", "''") + "'"

emit_log("info", "amr-etl starting", run_id=RUN_ID, isolate_id=ISOLATE_ID)

sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(JOB_NAME, args)

# The S3 Tables catalog is configured at Spark session startup via the Glue job's
# --conf arguments using the Amazon S3 Tables Catalog for Apache Iceberg client
# (catalog name 's3tablesbucket', catalog-impl S3TablesCatalog, warehouse = table
# bucket ARN, plus the --extra-jars client JAR). This talks directly to the
# S3 Tables API, so this script simply references s3tablesbucket.amr_db.<table>.

hamr_schema = StructType([
    StructField("input_file_name", StringType(), True),
    StructField("gene_symbol", StringType(), True),
    StructField("gene_name", StringType(), True),
    StructField("reference_database_id", StringType(), True),
    StructField("reference_database_version", StringType(), True),
    StructField("reference_accession", StringType(), True),
    StructField("sequence_identity", StringType(), True),
    StructField("reference_length", StringType(), True),
    StructField("coverage_depth", StringType(), True),
    StructField("coverage_percentage", StringType(), True),
    StructField("drug_class", StringType(), True),
    StructField("antimicrobial_agent", StringType(), True),
    StructField("resistance_mechanism", StringType(), True),
    StructField("input_sequence_id", StringType(), True),
    StructField("input_gene_start", StringType(), True),
    StructField("input_gene_stop", StringType(), True),
    StructField("strand_orientation", StringType(), True),
    StructField("input_protein_length", StringType(), True),
    StructField("input_protein_start", StringType(), True),
    StructField("input_protein_stop", StringType(), True),
    StructField("analysis_software_name", StringType(), True),
    StructField("analysis_software_version", StringType(), True),
    StructField("reference_file_path", StringType(), True),
])

input_path = f"s3://{HARMONIZED_BUCKET}/{HARMONIZED_KEY}"
emit_log("info", "Reading hAMRonization TSV", run_id=RUN_ID, path=input_path)

try:
    hamr_df = (
        spark.read
        .option("sep", "\t")
        .option("header", "true")
        .schema(hamr_schema)
        .csv(input_path)
    )
    hamr_df = (hamr_df
               .withColumn("isolate_id", F.lit(ISOLATE_ID))
               .withColumn("run_id", F.lit(RUN_ID))
               .withColumn("ts", F.current_timestamp())
               .withColumn("gene_id", F.concat_ws(
                   ":",
                   F.coalesce(F.col("reference_accession"), F.lit("")),
                   F.coalesce(F.col("gene_symbol"), F.lit("")),
               )))
    row_count = hamr_df.count()
    hamr_df.createOrReplaceTempView("incoming")
    emit_log("info", "TSV loaded", run_id=RUN_ID, isolate_id=ISOLATE_ID, rows=row_count)
except Exception as exc:
    emit_log("error", f"Failed to read hAMRonization TSV: {exc}",
             run_id=RUN_ID, isolate_id=ISOLATE_ID)
    job.commit()
    raise SystemExit(1) from exc

# MERGE INTO amr_profiles
emit_log("info", "MERGE INTO amr_profiles", run_id=RUN_ID, isolate_id=ISOLATE_ID)
try:
    spark.sql(f"""
    MERGE INTO s3tablesbucket.amr_db.amr_profiles AS target
    USING (
        SELECT
            isolate_id,
            gene_id,
            COALESCE(gene_symbol, gene_name, '') AS gene_name,
            analysis_software_name AS detection_tool,
            CAST(COALESCE(sequence_identity, '0') AS DOUBLE) AS confidence,
            {sql_str(ORGANISM)} AS organism,
            run_id,
            ts
        FROM incoming
        WHERE gene_id IS NOT NULL AND gene_id != ':'
    ) AS source
    ON target.isolate_id = source.isolate_id AND target.gene_id = source.gene_id
    WHEN MATCHED THEN UPDATE SET
        gene_name      = source.gene_name,
        detection_tool = source.detection_tool,
        confidence     = source.confidence,
        run_id         = source.run_id,
        ts             = source.ts
    WHEN NOT MATCHED THEN INSERT (
        isolate_id, gene_id, gene_name, detection_tool,
        confidence, organism, run_id, ts
    ) VALUES (
        source.isolate_id, source.gene_id, source.gene_name, source.detection_tool,
        source.confidence, source.organism, source.run_id, source.ts
    )
    """)
    emit_log("info", "MERGE INTO amr_profiles complete", run_id=RUN_ID, isolate_id=ISOLATE_ID)
except Exception as exc:
    emit_log("error", f"MERGE INTO amr_profiles failed: {exc}",
             run_id=RUN_ID, isolate_id=ISOLATE_ID)
    job.commit()
    raise SystemExit(1) from exc

# MERGE INTO isolate_metadata
emit_log("info", "MERGE INTO isolate_metadata", run_id=RUN_ID, isolate_id=ISOLATE_ID)
try:
    spark.sql(f"""
    MERGE INTO s3tablesbucket.amr_db.isolate_metadata AS target
    USING (
        SELECT
            {sql_str(ISOLATE_ID)} AS isolate_id,
            {sql_str(ORGANISM)} AS organism,
            {sql_str(SRA_ACCESSION)} AS sra_accession,
            {sql_str(SOURCE_PROVENANCE)} AS source_provenance,
            {sql_str(LICENSE)} AS license,
            CURRENT_TIMESTAMP AS ingestion_ts
    ) AS source
    ON target.isolate_id = source.isolate_id
    WHEN MATCHED THEN UPDATE SET
        organism          = source.organism,
        sra_accession     = source.sra_accession,
        source_provenance = source.source_provenance,
        license           = source.license,
        ingestion_ts      = source.ingestion_ts
    WHEN NOT MATCHED THEN INSERT (
        isolate_id, organism, sra_accession, source_provenance, license, ingestion_ts
    ) VALUES (
        source.isolate_id, source.organism, source.sra_accession,
        source.source_provenance, source.license, source.ingestion_ts
    )
    """)
    emit_log("info", "MERGE INTO isolate_metadata complete", run_id=RUN_ID, isolate_id=ISOLATE_ID)
except Exception as exc:
    emit_log("error", f"MERGE INTO isolate_metadata failed: {exc}",
             run_id=RUN_ID, isolate_id=ISOLATE_ID)
    job.commit()
    raise SystemExit(1) from exc

emit_log("info", "amr-etl job complete", run_id=RUN_ID, isolate_id=ISOLATE_ID)
job.commit()
