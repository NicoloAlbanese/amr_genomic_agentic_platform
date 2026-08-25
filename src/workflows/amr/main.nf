#!/usr/bin/env nextflow
nextflow.enable.dsl=2

// ─── AMR genomics pipeline for AWS HealthOmics ──────────────────────────────
// One workflow, three tasks, data flowing through Nextflow channels:
//   FASTP (read QC/trim) -> SKESA (de novo assembly) -> AMRFINDERPLUS (AMR genes)
//
// Merging assembly and screening into a single HealthOmics run avoids a fragile
// S3 hand-off between two separate runs and matches how nf-core AMR pipelines
// are structured. All task outputs are published to /mnt/workflow/pubdir, which
// HealthOmics exports to the run's S3 output location.
//
// Container image URIs are passed as parameters (HealthOmics best practice) so
// the workflow stays account/Region agnostic and image access is verified
// before the run starts. HealthOmics tasks have no internet access, so the
// AMRFinderPlus database must be baked into the AMR container image.

params.read1             = null        // R1 FASTQ S3 URI
params.read2             = null        // R2 FASTQ S3 URI
params.isolate_id        = "unknown"
params.organism          = "Salmonella"
params.min_length        = 50
params.fastp_args        = "--detect_adapter_for_pe --correction"
params.assembly_container = null       // fastp + SKESA image URI
params.amr_container      = null       // AMRFinderPlus (DB bundled) image URI

process FASTP {
    tag "${isolate_id}"
    container params.assembly_container
    publishDir "/mnt/workflow/pubdir", mode: 'copy'
    errorStrategy 'retry'
    maxRetries 2
    cpus 4
    memory '8 GB'

    input:
    tuple val(isolate_id), path(r1), path(r2)

    output:
    tuple val(isolate_id), path("${isolate_id}_trimmed_R1.fastq.gz"), path("${isolate_id}_trimmed_R2.fastq.gz"), emit: trimmed_reads
    path "${isolate_id}_fastp.json", emit: json

    script:
    """
    fastp \\
      --in1 ${r1} \\
      --in2 ${r2} \\
      --out1 ${isolate_id}_trimmed_R1.fastq.gz \\
      --out2 ${isolate_id}_trimmed_R2.fastq.gz \\
      --json ${isolate_id}_fastp.json \\
      --html ${isolate_id}_fastp.html \\
      --thread ${task.cpus} \\
      --length_required ${params.min_length} \\
      ${params.fastp_args}
    """
}

process SKESA {
    tag "${isolate_id}"
    container params.assembly_container
    publishDir "/mnt/workflow/pubdir", mode: 'copy'
    cpus 8
    memory '32 GB'

    input:
    tuple val(isolate_id), path(r1), path(r2)

    output:
    tuple val(isolate_id), path("${isolate_id}_contigs.fasta"), emit: contigs

    script:
    """
    skesa \\
      --reads ${r1},${r2} \\
      --contigs_out ${isolate_id}_contigs.fasta \\
      --cores ${task.cpus} \\
      --memory ${(task.memory.toGiga() as int)}
    """
}

process AMRFINDERPLUS {
    tag "${isolate_id}"
    container params.amr_container
    publishDir "/mnt/workflow/pubdir", mode: 'copy'
    cpus 4
    memory '8 GB'

    input:
    tuple val(isolate_id), path(contigs)

    output:
    tuple val(isolate_id), path("${isolate_id}_amrfinderplus.tsv"), emit: results

    script:
    def orgFlag = params.organism ? "--organism ${params.organism}" : ""
    """
    # The AMRFinderPlus database is bundled in the image (no internet in
    # HealthOmics tasks). Run against the assembled nucleotide contigs.
    amrfinder \\
      --nucleotide ${contigs} \\
      ${orgFlag} \\
      --output ${isolate_id}_amrfinderplus.tsv \\
      --threads ${task.cpus} \\
      --plus
    """
}

workflow {
    if (!params.read1 || !params.read2) {
        error "Parameters 'read1' and 'read2' are required (paired-end FASTQ S3 URIs)"
    }
    if (!params.assembly_container || !params.amr_container) {
        error "Parameters 'assembly_container' and 'amr_container' are required"
    }

    reads_ch = Channel.of(tuple(params.isolate_id, file(params.read1), file(params.read2)))

    FASTP(reads_ch)
    SKESA(FASTP.out.trimmed_reads)
    AMRFINDERPLUS(SKESA.out.contigs)
}
