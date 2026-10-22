# Agate-Liara progress

## 2026-10-22 — first live deploy preparation
- Source brief reread: `C:/Users/kavosh/Downloads/IMPLEMENTATION_PROMPT.md`.
- No previous PROGRESS.md found in this workspace; this is a new continuation record.
- Owner fixed Windows hosts manually. Agent has not changed network code or system networking.
- Read-only preflight rerun: 4/4 HTTP 200; `.agate/preflight-1792677883416.json`.
- Team's project and domain lists are empty. No provider mutation performed yet.
- Live `plans.projects` is a keyed object; RAM/CPU use uppercase object fields. Bundle plans are keyed by plan ID, then bundle ID.
- First-deploy scope: only `./demo-site`, app `agate-liara`, node platform, port 3000. Await explicit plan selection and create/deploy approval.
- If `agate-liara.liara.run` is unreachable: report exact error; do not alter networking.

## Live attempt results (same session)
- `deploy_project` invoked through actual MCP stdio using `scripts/mcp-call.ts`.
- Owner selected `small-g2/basic` (750,000 Tomans/month resources+bundle) and explicitly approved one create. Provider rejected with `g2_plan_unavailable`; GET projects remained empty.
- Owner separately approved `ir-small/default` (~950,000 Tomans/month). Provider rejected with `network_is_required`; no app created.
- Official CLI source confirmed `/v1/networks`. GET showed none. Owner explicitly approved one POST with `{networkName:"agate-liara"}`.
- Network created and GET-verified: `6ada1e64b3b5ca83e1ee0ce1`, name `agate-liara`. This is the only successfully created provider resource. Do not delete it without owner approval.
- Owner explicitly approved a new app-create with this network, `ir-small/default`, platform node. Provider rejected: `"bundlePlanID" must be one of [free, basic, standard, pro]`.
- Reconciliation GET: projects still `[]`; network exists. The legacy plans response offers only `projectBundlePlans.g1.default`, contradicting write validation; do not guess a different paid bundle or retry automatically.
- No source upload, release creation, env change, deployment, restart or resize was performed.
- Direct public GET `https://agate-liara.liara.run/health` failed: `fetch failed`; cause `getaddrinfo ENOTFOUND agate-liara.liara.run`, code `ENOTFOUND`. No HTTP status or health payload received. Network code/system settings untouched.
- Next gate: obtain an authoritative valid plan/bundle combination for this team (or enabled g2 access), then fresh explicit app-create approval. After app exists, obtain separate upload/release approval and resume deploy_project. Do not claim deployment or health PASS.
