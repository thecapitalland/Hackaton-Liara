# Implementer handoff — OpsPilot v1.1

**Status:** requirements only, not deployed. For the full PRD + 42-feature backlog + API matrix + sample app + testing/demo package use the separately delivered OpsPilot Developer Pack v1.1. Do not claim the package is an implemented agent.

## Architecture
Node.js + TypeScript, LangGraph JS with durable checkpointing for the authenticated web runtime, optional stdio MCP interface, single Liara API gateway, deterministic policy engine, secret manager and operation journal. Separate the runtime model API from coding IDE. Use the model candidates in `docs/MODEL_ROUTING.md`.

## Implementation order
1. Verify Liara token with read-only GET /v1/projects and record actual team scope.
2. Verify official API definitions for app creation, plans, source upload, deployments, releases, logs, metrics, env update and restart; mark unsupported capabilities.
3. Implement LangGraph pause/resume, denied approval = no writes, actor/app/action/params hash binding, expiring single-use grants, non-idempotent reconciliation.
4. Use a disposable allowlisted app; create a plan proposal based on real platform and price capabilities, obtain operator approval, deploy, verify live HTTP 200.
5. Inject an isolated missing-configuration failure; gather real Liara observations; rank hypotheses with evidence IDs. Get separate repair approval, apply once and prove HTTP 200 recovery.
6. Implement compact Persian web console for inspect/propose/approve/verify states. Show real release IDs, statuses and limitations.
7. Record a five-minute demo with actual execution, not mock responses. Never expose tokens or private logs.

## Tools
The PowerShell preflight only calls GET /v1/projects, and **does not deploy or alter anything**. Existing owner websites and production applications are out of scope.

## Review gates
G0 API authentication read-only; G1 HITL and policy mocked; G2 owner-approved disposable real deployment; G3 live 500 -> root cause -> approved remediation -> verified recovery; G4 UI, GitHub MD, video.

Do not overbuild 24/7 monitoring, generic multi-cloud, or three independent orchestrators. Torob and Wallex domain features are separate challenges.
