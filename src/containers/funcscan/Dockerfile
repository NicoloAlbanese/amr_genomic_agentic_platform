# AMR screening container for the HealthOmics AMR workflow.
#
# Based on the StaPH-B ncbi-amrfinderplus image, which ships AMRFinderPlus
# together with its reference database. HealthOmics workflow tasks have no
# internet access, so the database must be present in the image (no
# `amrfinder --update` at run time). AMRFinderPlus is NCBI's reference tool for
# detecting acquired AMR genes and resistance point mutations in assembled
# nucleotide sequence.
#
# Pinned to a specific version+database tag for reproducibility.
FROM --platform=linux/amd64 staphb/ncbi-amrfinderplus:4.2.7-2026-03-24.1

# HealthOmics collects per-task metrics by invoking `ps` inside the task
# container when execution reports are enabled; ensure procps is present.
USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends procps && \
    rm -rf /var/lib/apt/lists/*

# Sanity-check the tool and its bundled database at build time so a broken base
# image fails the build rather than the workflow run. `amrfinder --version`
# prints both the software and database versions when the database is present.
RUN amrfinder --version

WORKDIR /data
