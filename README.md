# OpsPilot — Liara Hackathon

AI DevOps + SRE assistant built around **Liara API + LangGraph JS + MCP**, with **human approval before sensitive operations** and evidence-based incident diagnosis.

**Status:** Requirements / bootstrap only. No Liara deployment or live SRE action has been performed.

## Architecture decisions (2026-10-22)
- LangGraph JS StateGraph, durable checkpointing and interrupt/resume for deploy + diagnose/fix flows.
- Deterministic approval/policy gate **outside** the LLM, with immutable scope, action hash, expiry, one-time grant and reconciliation.
- MCP local tool surface is optional; web console and LangGraph runtime reuse the same Liara service adapter.
- Model routing is configurable: Grok (RCA trial), GLM Flash (light triage trial), MiniMax (coding/patch trial), Sol (independent reviewer only if its backend API is actually available). These are **provisional roles** pending project-specific tests.
- Liara API bearer token stays server-side. Nothing may write to a Liara account before scoped operator approval.
- Initial deliverable: disposable sample deployment -> actual HTTP 500 -> Liara logs/metrics -> explain root cause -> explicit approval -> controlled fix -> HTTP 200 verification.
- No blind retries for billable/non-idempotent operations. No customer production targets.

## Requirements and implementation
The full v1.1 developer pack contains PRD, feature backlog, API matrix, graph designs, model routing, tests, demo script and a **mock-only** LangGraph scaffold. It is prepared separately for repository import. This README is not evidence of implemented runtime.

Official references:
- https://developers.liara.ir/
- https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph

Owner: thecapitalland.