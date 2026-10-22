# Model routing v1.1 — provisional assignments

The runtime is **not tied to Cursor or Codex**. Distinguish the development workbench subscription from the model API actually used by LangGraph. A coding-client license is not an API credential.

| Task | Model to trial first | Challenger | Measure |
|---|---|---|---|
| Evidence-based SRE RCA | Grok 4.7 | MiniMax | rooted accuracy, JSON/tool validity, latency |
| Low-cost log triage | GLM-5.3-Flash | MiniMax | evidence fidelity, speed, price |
| Configuration patch analysis | MiniMax API-verified model | Grok | fix correctness, tests |
| Independent critique | Sol, **only if independent API is verified** | Grok / MiniMax | useful findings and false positives |
| Persian UX narrative | cheapest model that passes fixtures | provider fallback | comprehension and groundedness |

Routing requires separate provider adapters, exact model IDs, scoped secrets, schema validation, error handling and no secret forwarding. Use 10 synthetic incident fixtures to choose; model rankings above are **hypotheses**, not proven best choices. The policy executor is always deterministic, never selected by a model. Sol API provider/model ID is deliberately UNVERIFIED.

References: https://docs.x.ai/developers/grok-4-7 ; https://huggingface.co/zai-org/GLM-5.3-Flash ; https://www.minimax.io/models/text
