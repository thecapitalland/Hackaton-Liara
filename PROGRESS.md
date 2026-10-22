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

## Successful create · 2026-10-22 15:38 UTC
- Owner explicitly approved the exact displayed POST body (quote hash `5babbdf17815b314a5690effbaf4442c869b2e12203bbab86831bbd6d255eee8`).
- First approval record `5a13c217-1370-41e1-9cfe-0ebc86b201f4` was marked rejected by the local CLI because the PowerShell `yes` pipe delivered no usable stdin. No provider request was sent. A new record `53c302a6-3311-4c36-8a6c-6c2f49bc55c3` with the identical hash was approved and used.
- Exactly one POST `/v1/projects` with `{name:"agate-liara",planID:"small-g2",bundlePlanID:"basic",platform:"node",network:"6ada1e64b3b5ca83e1ee0ce1"}` returned `{"projectID":"6ada2dd838253e6cdf2b836e"}`.
- Reconciliation GET `/v1/projects` confirms one app: `_id 6ada2dd838253e6cdf2b836e`, `project_id agate-liara`, `type node`, `status ACTIVE`, `scale 1`, `planID small-g2`, `bundlePlanID basic`, network `6ada1e64b3b5ca83e1ee0ce1`, `isDeployed:false`.
- `GET /v1/projects/agate-liara` also returns `dns:[]`, `defaultSubdomain:true`, env keys `PORT`/`NODE_ENV` (values never read/printed), `hourlyPrice 659.72`, `bundleHourlyPrice 381.94`.
- No upload, release, deployment, env change, restart, scale, domain or SSL mutation was performed. `agate-liara.liara.run` is not expected to serve until a release is deployed.
- Next gate: separate explicit approval for source upload/release of `./demo-site`, then health verification. The app now exists, so retrying create is unnecessary and prohibited.

## First deployment attempt · 2026-10-22 15:53 UTC
- Owner approved the combined option: env merge + one upload + one release. Repo pushed to `origin/main` (`422ceee`) after secret-scan PASS; `.env` is untracked and was never committed.
- Deployment package: 11843 bytes (11.6KB), 5 files (`liara.json`, `package.json`, `public/app.js`, `public/styles.css`, `server.mjs`), SHA-256 `30dab33e…c6ebf2`; `node_modules`, `.env` and `test.mjs` excluded. Demo tests 7/7 PASS locally.
- Env merge: one approved `POST /v1/projects/update-envs` succeeded; `totalKeys=4` (`PORT`, `NODE_ENV` preserved; `BUG_MODE`, `ADMIN_KEY` added). Values redacted.
- Deploy approval `b5e115c7-da44-418c-8c76-9cef710eec6e` was consumed once. Source upload succeeded, then `POST /v2/projects/agate-liara/releases` returned **400**: `"build.location" must be one of [iran, germany]`. No `releaseID`, no build logs, no running version; `isDeployed:false`.
- Root cause: our release body sent `build.location:"."` (source path) instead of the build region. Fixed locally in `buildReleaseBody`: `location` defaults to `iran` (override `LIARA_BUILD_LOCATION`), validated against `iran|germany`; dockerfile remains docker-only. Typecheck PASS, tests 40/40 PASS.
- `GET /v2/projects/agate-liara/sources` returns 404, so the uploaded sourceID cannot be recovered; a retry needs one new upload and one new release. No automatic retry was performed.
- Awaiting fresh approval. No further provider write occurred after the 400.

## Third deployment attempt · 2026-10-22 16:03–16:14 UTC
- Owner approved one retry after the `build.location` fix; `dist` was rebuilt before execution.
- Upload succeeded; release `6ada364eb3b5ca83e1f16704` was created with `build.location=iran`.
- Build started (`npm install` via the Liara mirror) but `waitForRelease` reached its 10-minute timeout without a success state; result `status:"timeout"`, `stage:"build"`, `ok:false`. `isDeployed:false`; no retry was attempted.
- Build-log tail contained repeated ` ---> Using cache` and `> Running npm install...` lines with no completion. The cause is not yet established; any follow-up must be read-only (release status/build logs).
- Any further deploy attempt requires a fresh approval box. Expired approvals are never auto-renewed.

## Mandatory safety fixes (owner instruction)
- `scripts/ensure-build.ts`: `ensureBuild()` runs `npm run build` and aborts if it fails. `scripts/mcp-call.ts` and `scripts/smoke.ts` call it before spawning `dist/index.js`; `npm start` also builds via `prestart`. This prevents stale-code execution (the cause of the repeated 400).
- `src/approval.ts`: terminal states (`expired`, `rejected`, `used`) are immutable; `setApprovalStatus(id,"approved")` after `expiresAt` marks the record expired instead of approving; executing an expired record returns `APPROVAL_EXPIRED` with `freshApprovalRequired:true`, and `scripts/approve.ts` reports that a fresh request is required.
- Evidence: `npm run typecheck` PASS, `npm run build` PASS, `npm test` 44/44 PASS. New tests cover no-auto-renew of expired approvals, terminal-state immutability, and build-before-run behavior. No provider write was performed as part of these fixes.

## Release timeout was a false alarm · 2026-10-22 17:44 UTC
- Read-only recheck: release `6ada364eb3b5ca83e1f16704` is `state:"READY"`; app `isDeployed:true`, `status:ACTIVE`.
- Live verification: `GET https://agate-liara.liara.run/health` → **200** `{"status":"ok","bugMode":"off","uptime":5401,…}`; homepage → **200**, 10,362 bytes, Agate brand present.
- Actual build timeline: source fetch 16:14:06, `npm install` 16:14:09, `up to date in 1s` 16:14:10, image built 16:14:19, push 100% (1.56GB) 16:14:31. Build finished ~25s after start.
- Root cause of the reported timeout: `GET /v1/releases/{id}` nests state under `release.state`, while `releaseState()` read only top-level fields, so the wait loop never saw `READY`. Build logs without `since` also return only the first 20 lines, so the tail stopped at `Running npm install...`.
- Fix: `unwrapRelease()` in `src/liara/release.ts`, used by `composite.ts` and `liara_release_status`. Regression test added; typecheck PASS, tests **45/45** PASS. No new release was created.
- Package facts: uploaded archive was demo-site only — 5 files, 11,843 bytes, SHA-256 `30dab33e…c6ebf2`, zero dependencies/devDependencies, no lockfile. Root repo deps/lockfile were not uploaded.
- Details and recommendations are in `LESSONS.md`.
- Owner decision: **no new release**. The current `READY` deployment is accepted; no upload/release or any other provider write was performed for this decision.

## Leak scenario · 2026-10-22 21:38–22:32 (+03:30)
- Owner approved one `BUG_MODE=leak` env write (approval `c7ff03ed-…`); service restarted and leak became active.
- 30 HTTP probes (`/`, `/api/challenges`, `/api/status`, 10 each) returned 200; homepage p50 **2124ms**.
- Health: `extMB` grew **8.5MB → 473.5MB** in ~95s; Liara events showed **3× oom** plus `die`/`start` restart cycles.
- `diagnose` used the real LLM (`analysisSource:"llm"`, `gpt-5-mini`): top cause **OOM/leak 88%**, second slow responses 45%. Metrics CPU/memory series were unavailable (503); logs API returned no app logs. Details in `LESSONS.md`.
- Owner approved the fix `BUG_MODE=off` (approval `c766a014-…`, one write). Post-fix: four health samples over 60s showed `bugMode:"off"`, `extMB` stable **3.5MB**, `rssMB` ~53.7MB, uptime increasing; no new OOM. Leak resolved.
- Slow and error500 scenarios remain pending; requiring fresh approvals.

## Configurable approval policy · 2026-10-22
- Added `APPROVAL_POLICY` (`strict` default, `balanced`, `auto`) and a single `decideApproval()` in `src/approval.ts`. Risk is `low|medium|high`; high-risk/costly actions always require approval.
- `balanced` at the time: `restart` and `BUG_MODE=off` auto; other env changes/releases require approval. `auto`: low/medium auto. **Superseded 2026-10-23:** the demo-specific `BUG_MODE=off` exception was removed; balanced now auto-runs `restart` and only an exact, journal-backed `rollback_last_env_change`; `liara_set_env` remains medium.
- Automatic runs include «اجرای خودکار طبق سیاست …» and are audited as `auto:<policy>`. `npm test` **55/55** PASS at the time; typecheck PASS. No live provider write for policy tests.

## Generic env rollback + incident-window diagnosis · 2026-10-23
- Replaced the demo-specific `BUG_MODE=off` watcher remedy with `rollback_last_env_change`: it finds the latest env change before `incidentAt` across the local journal, audit metadata, and Liara `ENV_UPDATE` release metadata, then reverts only that change's keys.
- Added `.agate/env-history-<app>.json` (gitignored, mode 0600) with raw before/after values only for keys changed through this server. Audit/release-only changes are metadata and are never rolled back blindly. A latest rollback record suppresses older journal candidates, and current-env mismatch/newer changes require `restart`.
- `rollback_last_env_change` is declared `low` risk; `liara_set_env` remains `medium`. The hidden BUG_MODE exception was removed. A rollback proposal without `incidentAt` is pinned at proposal time so late approval cannot revert a newer change.
- Diagnosis evidence is anchored to `incidentAt` with a 10-minute default window; old/undated events and old logs are dropped, and crash-loop evidence uses the same window. The watcher now passes the same cycle's 9 probe samples and events into diagnosis, so counts match (e.g. `3/9`).
- The LLM receives only `restart` plus `rollback_last_env_change` when an exact revertable change exists; invalid selections are ignored and rules fallback applies. Added regression tests for journal/window/audit/release/rollback-plan/prompt/same-cycle behavior.
- Final local checks: typecheck PASS, tests **87/87**, build PASS, offline smoke PASS (33 tools), live read-only smoke PASS. `npm run secret-scan` PASS. Live env rollback and live watcher remediation remain **NOT_RUN**; `APPROVAL_POLICY=strict` and no watcher process is running.
- Connection UX: `SERVER_INSTRUCTIONS` and `--help` now document the start path and low-risk action; startup stderr reports version, allowed app, token state, approval policy, watch settings, and `cwd`/state/package paths. README updated with journal privacy, incident-window, remedy-selection, and IDE connection guidance.
