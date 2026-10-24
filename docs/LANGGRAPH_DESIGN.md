# LangGraph-first OpsPilot v1.1

Architecture: Liara API adapter + LangGraph JS workflow engine + optional MCP adapters + web console + independent policy gate.

## Deploy graph
Discover -> Inspect real Liara plans -> Propose -> Human interrupt -> Server-side grant validation -> Reconcile provider state -> Execute once -> Verify HTTP/release -> Report.

## SRE graph
Probe -> Collect timestamped logs/metrics/events -> Rank evidence-linked hypotheses -> Propose action -> Human interrupt -> Validate operation-specific grant -> Execute once -> Re-probe -> Report.

Use LangGraph `interrupt()` and `Command({resume})` with same `thread_id`. For web, use durable checkpointer. `MemorySaver` is for development only. Because nodes may re-run on resume, no external write before interrupt; every write must pass backend policy and replay checks. A model answer or chat approval phrase is not execution authorization. Store only sanitized state and evidence.

Reference: https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph
