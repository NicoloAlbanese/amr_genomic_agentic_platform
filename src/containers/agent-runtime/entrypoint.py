"""
AMR AgentCore Runtime entrypoint.

GET  /ping         -> {"status": "ok"}   (health check, must respond in 120s)
POST /invocations  -> single JSON response

Uses Strands Agents SDK to orchestrate Claude + 4 Athena-backed tool Lambdas.
"""
from __future__ import annotations

import json
import logging
import os
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import boto3

# Strands Agents SDK (installed in container image)
try:
    from strands import Agent, tool
    from strands.models import BedrockModel
    STRANDS_AVAILABLE = True
except ImportError:
    STRANDS_AVAILABLE = False

logger = logging.getLogger("amr-agent-runtime")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

REGION = os.environ.get("AWS_REGION", "us-west-2")
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "global.anthropic.claude-opus-4-5-20251101-v1:0")
GUARDRAIL_ID = os.environ.get("GUARDRAIL_ID", "")
GUARDRAIL_VERSION = os.environ.get("GUARDRAIL_VERSION", "DRAFT")

TOOL_FN_QUERY_AMR = os.environ.get("TOOL_FN_QUERY_AMR", "")
TOOL_FN_TRENDS = os.environ.get("TOOL_FN_TRENDS", "")
TOOL_FN_COMPARE = os.environ.get("TOOL_FN_COMPARE", "")
TOOL_FN_GENE_INFO = os.environ.get("TOOL_FN_GENE_INFO", "")

lambda_client = boto3.client("lambda", region_name=REGION)

AMR_SYSTEM_PROMPT = (
    "You are an expert Antimicrobial Resistance (AMR) genomics analyst.\n"
    "You have access to four tools that query a curated AMR database:\n"
    "  1. query_amr_profiles  - find resistance genes by organism and date range\n"
    "  2. get_resistance_trends - monthly trend analysis of gene detections\n"
    "  3. compare_isolates     - compare resistance profiles across isolates\n"
    "  4. lookup_gene_info     - detailed information about a specific gene\n\n"
    "MANDATORY RULES:\n"
    "1. For EVERY AMR claim cite gene_id, tool_name, confidence from tool output.\n"
    "   Format: [gene_id: <id>, tool: <tool_name>, confidence: <value>]\n"
    "2. If tools return no results respond: 'I cannot answer - no data found in AMR database.'\n"
    "   Do NOT invent AMR data.\n"
    "3. For questions outside AMR genomics respond:\n"
    "   'I can only answer questions about AMR genomics and resistance gene data.'\n"
    "4. Always invoke at least one tool before answering an AMR question.\n"
)


def _invoke_tool_lambda(function_name: str, payload: dict) -> dict:
    """Invoke a tool Lambda and return parsed response. Never raises."""
    if not function_name:
        return {"error": "Tool Lambda not configured", "results": [], "tool_name": "unknown"}
    try:
        response = lambda_client.invoke(
            FunctionName=function_name,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload).encode(),
        )
        raw = response["Payload"].read()
        result = json.loads(raw)
        # Unwrap API Gateway-style body
        if isinstance(result.get("body"), str):
            try:
                result = json.loads(result["body"])
            except (json.JSONDecodeError, KeyError):
                pass
        return result
    except Exception as exc:  # noqa: BLE001
        logger.error("Tool Lambda %s failed: %s", function_name, exc)
        return {"error": str(exc), "results": [], "tool_name": function_name}


if STRANDS_AVAILABLE:
    @tool
    def query_amr_profiles(
        organism: str,
        date_from: str = "",
        date_to: str = "",
        limit: int = 20,
    ) -> str:
        """
        Query AMR resistance gene profiles by organism and optional date range.

        Args:
            organism: Bacterial organism (e.g. Salmonella, E. coli)
            date_from: Start date YYYY-MM-DD (optional)
            date_to: End date YYYY-MM-DD (optional)
            limit: Max results (default 20)
        """
        return json.dumps(
            _invoke_tool_lambda(
                TOOL_FN_QUERY_AMR,
                {"organism": organism, "date_from": date_from, "date_to": date_to, "limit": limit},
            )
        )

    @tool
    def get_resistance_trends(
        gene_id: str = "",
        resistance_class: str = "",
        months: int = 12,
    ) -> str:
        """
        Get monthly trends for AMR gene detections over time.

        Args:
            gene_id: Gene identifier (optional, e.g. blaTEM, mcr)
            resistance_class: Drug class (optional, e.g. Beta-lactam)
            months: Months of history (default 12)
        """
        return json.dumps(
            _invoke_tool_lambda(
                TOOL_FN_TRENDS,
                {"gene_id": gene_id, "resistance_class": resistance_class, "months": months},
            )
        )

    @tool
    def compare_isolates(organism: str = "", limit: int = 20) -> str:
        """
        Compare AMR resistance profiles across isolates filtered by organism.

        Args:
            organism: Organism name filter (e.g. Salmonella)
            limit: Max results (default 20)
        """
        return json.dumps(
            _invoke_tool_lambda(
                TOOL_FN_COMPARE,
                {"organism": organism, "limit": limit},
            )
        )

    @tool
    def lookup_gene_info(gene_id: str, organism: str = "") -> str:
        """
        Look up information about a specific AMR resistance gene.

        Args:
            gene_id: Gene identifier (e.g. blaTEM, mcr-1, vanA)
            organism: Optional organism filter
        """
        return json.dumps(
            _invoke_tool_lambda(
                TOOL_FN_GENE_INFO,
                {"gene_id": gene_id, "organism": organism},
            )
        )

    AMR_TOOLS = [query_amr_profiles, get_resistance_trends, compare_isolates, lookup_gene_info]
else:
    AMR_TOOLS = []


def _build_agent() -> Any:
    """Build a Strands Agent with Bedrock model and AMR tools."""
    if not STRANDS_AVAILABLE:
        return None
    model_kwargs: dict = {
        "model_id": MODEL_ID,
        "region_name": REGION,
        "max_tokens": 4096,
    }
    if GUARDRAIL_ID:
        model_kwargs["guardrail_config"] = {
            "guardrailIdentifier": GUARDRAIL_ID,
            "guardrailVersion": GUARDRAIL_VERSION,
            "trace": "enabled",
        }
    model = BedrockModel(**model_kwargs)
    return Agent(model=model, tools=AMR_TOOLS, system_prompt=AMR_SYSTEM_PROMPT)


def _handle_invocation(event: dict) -> dict:
    """Parse request and call Strands agent."""
    payload = event.get("payload", {})
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = {"input": {"prompt": payload}}

    prompt = (
        payload.get("input", {}).get("prompt")
        or payload.get("prompt")
        or event.get("inputText")
        or ""
    )
    session_id = event.get("sessionId", "")

    if not prompt:
        return {"type": "error", "error": "No prompt provided"}

    if not STRANDS_AVAILABLE:
        return {
            "type": "text",
            "output": f"[Strands not available] AMR Agent received: {prompt}",
            "session_id": session_id,
        }

    agent = _build_agent()
    t0 = time.time()
    result = agent(prompt)
    elapsed_ms = int((time.time() - t0) * 1000)
    output_text = str(result) if not isinstance(result, str) else result

    logger.info(
        json.dumps({
            "level": "INFO",
            "event": "invocation_complete",
            "session_id": session_id,
            "elapsed_ms": elapsed_ms,
        })
    )

    return {
        "type": "text",
        "output": output_text,
        "session_id": session_id,
        "elapsed_ms": elapsed_ms,
    }


class AgentRuntimeHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler for AgentCore Runtime service contract."""

    def log_message(self, fmt, *args):
        pass  # suppress default access log

    def _send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/ping":
            self._send_json(200, {"status": "ok"})
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/invocations":
            self._send_json(404, {"error": "Not found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length) if length else b"{}"

        try:
            event = json.loads(raw_body)
        except json.JSONDecodeError as exc:
            self._send_json(400, {"error": f"Invalid JSON: {exc}"})
            return

        if event.get("type") == "ping":
            self._send_json(200, {"status": "ok"})
            return

        try:
            response_body = _handle_invocation(event)
            self._send_json(200, response_body)
        except Exception as exc:
            logger.error("Invocation error: %s\n%s", exc, traceback.format_exc())
            self._send_json(500, {"error": str(exc), "type": "error"})


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    logger.info(
        "AMR AgentCore Runtime starting on port %d | model=%s | guardrail=%s | strands=%s",
        port, MODEL_ID, GUARDRAIL_ID or "none", STRANDS_AVAILABLE,
    )
    server = HTTPServer(("0.0.0.0", port), AgentRuntimeHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
