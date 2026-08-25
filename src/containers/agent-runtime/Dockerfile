FROM --platform=linux/arm64 python:3.11-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl && \
    rm -rf /var/lib/apt/lists/*

# Install Strands Agents SDK and AWS SDK for AgentCore Runtime
# Using --no-cache-dir to minimise image size (critical for 120s init constraint)
RUN pip install --no-cache-dir \
    strands-agents \
    boto3 \
    botocore

# Create app directory
WORKDIR /app

# Health check endpoint for AgentCore Runtime — must respond on /ping within 120s
COPY entrypoint.py /app/entrypoint.py

EXPOSE 8080

ENTRYPOINT ["python", "/app/entrypoint.py"]
