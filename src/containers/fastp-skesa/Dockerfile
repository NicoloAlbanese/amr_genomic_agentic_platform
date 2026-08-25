FROM --platform=linux/amd64 ubuntu:22.04 AS build

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends fastp && \
    rm -rf /var/lib/apt/lists/*

# ─── Final stage ───────────────────────────────────────────────────────────────
FROM --platform=linux/amd64 ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Copy fastp from build stage
COPY --from=build /usr/bin/fastp /usr/local/bin/fastp

# Install SKESA (genome assembler from NCBI) and dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libgomp1 \
        wget \
        ca-certificates && \
    # Install SKESA via ncbi-datasets or conda-forge binary
    apt-get install -y --no-install-recommends skesa 2>/dev/null || \
    ( wget -q https://ftp.ncbi.nlm.nih.gov/pub/usher/skesa/2.4.0/skesa.ubuntu.22 \
        -O /usr/local/bin/skesa && \
      chmod +x /usr/local/bin/skesa ) && \
    rm -rf /var/lib/apt/lists/*

# FR-019: Container security — non-root user
RUN groupadd --system --gid 1000 amruser && \
    useradd --system --uid 1000 --gid amruser --home-dir /data --shell /sbin/nologin amruser && \
    mkdir -p /data && chown -R amruser:amruser /data

WORKDIR /data
USER 1000:1000

ENTRYPOINT ["/bin/bash", "-c"]
CMD ["fastp --version && skesa --version 2>&1 || skesa --help 2>&1 | head -5"]
