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

## Retry requested by owner: ir-small/basic
- Previous provider validation: `"bundlePlanID" must be one of [free, basic, standard, pro]`; `default` is not accepted by POST even though GET lists `g1.default`.
- New exact request prepared: `{name:"agate-liara",planID:"ir-small",bundlePlanID:"basic",platform:"node",network:"6ada1e64b3b5ca83e1ee0ce1"}`.
- Fresh preflight passed 4/4 (`.agate/preflight-1792680915523.json`). Network existence confirmed by GET; projects still empty.
- Read-only cost evidence: ir-small resources are 1319.44 Tomans/hour (~949996.8 Tomans per 720h). GET /v1/me does not expose a basic/standard bundle tariff for ir-small; total cost must not be claimed to be only 950,000 Tomans/month.
- Await explicit approval box before POST. If basic is rejected, propose standard but obtain a fresh approval before any POST. No upload or release in this scope.
- Owner approved exactly one ir-small/basic POST after seeing resource cost and the unknown bundle tariff; approval `48ba2d83-80c0-481a-81e3-b0dd0aa62c2a` was consumed.
- Result: provider rejected with `g1_plan_unavailable`. Reconciliation GET /v1/projects returned `{projects:[]}`, so agate-liara does not exist.
- Prepared ir-small/standard with the same platform/network as a proposal only. No standard POST until a new explicit approval. Changing the bundle may not fix a generation-level unavailability error.
- Owner cancelled standard. Approval `629c79e2-74de-4e97-bd42-934e018da8bc` marked rejected and audited; zero standard POSTs.

## Exact API catalog join (latest owner instruction)
- No provider mutations in this phase. GET /v1/me uses configured teamID; sanitized exact filtered subtrees saved to `docs/PLAN_CATALOG_LIVE.json` (no user/account/token fields).
- Strict filter: project.available === true AND project.region === "iran". Bundle.available === true under projectBundlePlans[exact planID] only. No g1/default cross-plan fallback, generation inference or hardcoded bundle fallback.
- ir-small and six other legacy available/iran project keys have no same-key bundle object, so they are excluded from create candidates despite appearing in projects.
- Lowest three API-listed combinations: small-g2/basic = 750000; small-g2/standard = 950000; medium-g2/basic = 1300000 Tomans/month. All include resources + bundle. These are advertised candidates, not proof that POST will accept them; previous g2_plan_unavailable remains relevant.
- `src/liara/plans.ts` is shared by deploy, create and liara_plans. Create/propose fetch fresh quotes before approval. The write executor re-fetches the catalog and rejects a missing pair, stale/absent quote or changed component prices before POST.
- Pending approvals generated by older code without a price quote cannot execute creation. New selection does not authorize POST; user approval remains mandatory. No upload/release.
- Owner selected small-g2/basic from the API-derived choice box: 475000 resources + 275000 bundle = 750000 Tomans/month. This was explicitly a selection only, not permission to POST. No create attempt made during catalog extraction/fix.
