FROM --platform=linux/amd64 python:3.11-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libgomp1 && \
    rm -rf /var/lib/apt/lists/*

# Install hAMRonization (harmonization of AMR gene detection outputs)
RUN pip install --no-cache-dir hamronization

# FR-019: Container security — non-root user
RUN groupadd --system --gid 1000 amruser && \
    useradd --system --uid 1000 --gid amruser --home-dir /data --shell /sbin/nologin amruser && \
    mkdir -p /data && chown -R amruser:amruser /data

WORKDIR /data
USER 1000:1000

ENTRYPOINT ["hamronize"]
CMD ["--help"]
