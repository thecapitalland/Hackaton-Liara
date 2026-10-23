# Verification evidence · cumulative through 2026-10-23

## Agentic investigate — 2026-10-23

LLM honesty: `llmEnabled` is not switched by a commit. It is true only when `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` are all set at runtime. Audit has 11 `diagnose` lines. Seven, from `2026-10-22T17:58:52Z` through `2026-10-22T21:55:39Z`, start with `منبع تحلیل: LLM (gpt-5-mini)` and did call the model. `2026-10-22T17:54:32Z` was HTTP 400 and stayed on rules. Two calls skipped the model because no legal hypothesis existed, including `2026-10-23T06:29:15Z`. The OpenCode ping sample that says `gpt-5-mini` matches pings while that model was configured; it is not the current `.env`. The local `.env` lost `LLM_BASE_URL` and `LLM_API_KEY` on 2026-10-23 after `b7ad2ab` until they were pointed at GapGPT again. No Liara write was part of that check.

Current gate on 2026-10-23 after projectPath, summary-memory, and the review fixes: typecheck PASS, `npm test` **141/141**, build PASS, offline smoke PASS with **34 tools**, `demo:test` 8/8. Same day, after `docs/TOOLS.md` and `test/tools-doc.test.ts`: typecheck PASS, `npm test` **142/142**, build PASS, secret-scan PASS on **104** commit-eligible files. Offline smoke and `demo:test` were not re-run for that doc change. Later the same day, disk mount follows `@liara/cli@9.6.0`: typecheck PASS, `npm test` **145/145**, build PASS, secret-scan **106** files. No Liara app was created and no approval card was approved for that change. The same day, create-plan selection follows `@liara/cli@9.6.0` `create.js:131-137`: typecheck PASS, `npm test` **152/152**, build PASS, secret-scan **110** files. A plan error does not send a second POST. No Liara app was created and no approval card was approved for that change. Live Liara reads stayed healthy. Product LLM calls resolve the hostname and refuse a loopback answer before sending the request. The OS resolver, via curl to the same hostname, returned HTTP 200. Later the same day, create-app POST follows `@liara/cli@9.6.0` `create.js:36-44` (`/v1/projects/`, fields `name`, `planID`, `platform`, `bundlePlanID`, `network`, `readOnlyRootFilesystem`; no `region`): typecheck PASS, `npm test` **154/154**, build PASS, secret-scan **112** files. `g2_plan_unavailable` still drops that plan from the next card and does not send a second POST; the message says the fault may be the request. No Liara app was created and no approval card was approved. Later the same day, `deploy_project` reads `GET /v1/networks` before creating an app (`base.js:186`). A missing network does not POST. An existing network is shown on the create card with its name and `_id`. An empty list opens a separate `liara_create_network` card at risk high. typecheck PASS, `npm test` **158/158**, build PASS, secret-scan **114** files. The live network list contained one network, name `agate-liara`. No app or network was created and no card was approved. The historical tables below stay as recorded, including the earlier 125/125 and 33-tool rows.

## Feature-freeze verification — 2026-10-23

This section records the feature-freeze run on 2026-10-23. Current numeric gates live in the README quality gate. Earlier sections stay historical. The legacy `BUG_MODE=off` policy exception remains superseded.

**Current correction (commit `e65c087`):** `rollback_last_env_change` is `risk=medium` and requires approval under both `strict` and `balanced`. `balanced` auto-runs only `low` actions such as `restart`; it does not auto-run rollback. Earlier sections that describe rollback as `low`/automatic are historical and superseded.

| Check | Result | Evidence / limits |
|---|---|---|
| `npm run typecheck` | PASS | `tsc -p tsconfig.json --noEmit` |
| `npm test` | PASS | **103/103**, 0 failed; includes elicitation, watch outage, redaction, single-line audit, human-approved audit, and the earlier approval tests. README quality gate is the reference |
| `npm run build` | PASS | `dist` refreshed |
| `npm run smoke -- --offline` | PASS | Real stdio handshake, discovers **33 tools**, ping |
| `npm run smoke` | PASS | Live read-only `liara_list_apps` + HTTPS probe; no provider mutation |
| `npm run demo:test` | PASS | 8/8; healthy, slow, error500, leak, admin POST, query-string rejection |
| `node dist/index.js --help` | PASS | Connection command/args/cwd, required variables, revertable-action summary |
| Startup stderr message | PASS | Verified from a real child process: version, allowed app, token configured/not configured, policy, watch app/interval, and `cwd`/state/package paths |
| `npm run secret-scan` | PASS | 82 commit-eligible files in the feature-freeze run; configured secrets/private-key markers absent (not a universal detector) |
| `git diff --check` | PASS | Exit 0; only Windows line-ending notices |
| Generic `rollback_last_env_change` | PASS (unit) | Latest journal/audit/release candidate, 10-minute window, exact before/after rollback, mismatch protection, rollback-loop suppression |
| Baseline-aware rollback | PASS (unit) | Healthy env snapshot is a third source; only changed keys are reverted; baseline file uses mode 0600 where supported; missing baseline returns a 3-option recovery card |
| LLM remedy list/selection | PASS (unit) | Prompt contains `restart` plus `rollback_last_env_change` only when an exact revertable change exists; invalid selections are ignored |
| Same-cycle probe samples | PASS (unit) | watch aggregates 3 routes × 3 samples = 9; diagnosis receives the same samples and reports `3/9`, not `2/3` |
| Incident-window anchoring | PASS (unit) | Logs/events/crash-loop evidence anchored to `incidentAt`; older events dropped |
| Live env rollback / live watcher remediation | NOT_RUN | Deferred to video recording; `APPROVAL_POLICY=strict`; zero provider mutations in these checks |
| OpenCode native MCP | PASS | OpenCode 2.1.2; repo `opencode.json` sets `codemode:false`; `opencode mcp list` → `✓ agate-liara connected`; direct native calls `agate-liara_ping`, `agate-liara_liara_list_apps`, `agate-liara_liara_status`, `agate-liara_http_probe`; **not** `scripts/mcp-call.ts` |
| Actual VS Code / Cursor / Codex connection | NOT_RUN | Only OpenCode 2.1.2 was natively verified; other IDE configs remain untested |
| Live app / release / health | PASS | Approved deploy of `./demo-site`. Release `6adb239b2c3f63ca360563ab` reached `READY`. Independent `GET /` and `GET /health` both HTTP 200. Health body `status=ok`, `bugMode=off`. Earlier p50 samples are historical. Env values were not printed |

## Successful app create (live, 15:38 UTC)
- Owner approved the exact displayed body: `{name:"agate-liara",planID:"small-g2",bundlePlanID:"basic",platform:"node",network:"6ada1e64b3b5ca83e1ee0ce1"}`, quote hash `5babbdf1…255eee8`, 750000 Tomans/month.
- Pre-state read-only GET: projects `[]`; networks contains `6ada1e64b3b5ca83e1ee0ce1` (`agate-liara`, projectCount 0).
- Approval `5a13c217-…` was locally rejected because the PowerShell stdin pipe failed; zero provider writes. Re-proposed with identical hash; `53c302a6-…` approved and consumed once.
- One `POST /v1/projects` returned `200 {"projectID":"6ada2dd838253e6cdf2b836e"}`.
- Reconciliation `GET /v1/projects` at create time: one app, `project_id agate-liara`, `status ACTIVE`, `planID small-g2`, `bundlePlanID basic`, network `6ada1e64b3b5ca83e1ee0ce1`. A release did not exist yet. `GET /v1/projects/agate-liara`: `dns:[]`, two env key names were present (values not printed), `hourlyPrice 659.72`, `bundleHourlyPrice 381.94`. Current status is README Current Status.
- No upload, release, deploy, env, restart, scale, domain or SSL mutation. Public health remains unverified until deployment; absence of deployment is not a health PASS.
- `npm run typecheck`: PASS. `npm test`: PASS, 37/37. `npm run build`: PASS. `npm run secret-scan`: PASS (60 files).

## Exact-catalog fix (earlier same day)
- `npx tsx scripts/plan-catalog.ts`: authenticated GET /v1/me with configured teamID; saved only filtered plans/projects+bundles to `docs/PLAN_CATALOG_LIVE.json`. 15 available Iran project keys; 8 have exact-key active bundle groups. Seven legacy keys have no matching bundle group and are excluded from create candidates.
- Owner selected `small-g2/basic` at displayed combined 750000 Tomans/month. Selection only; no provider mutation authorized or executed in this phase. Prior standard retry was explicitly rejected and audited locally.
- `npm run build`: PASS, exit 0.
- `npm test`: PASS, 36/36, 0 failed (~1.57s). Four catalog tests cover strict availability/region filtering, exact-key join, unknown prices, quote changes, and rejection before any mocked POST.
- `npm run secret-scan`: PASS, 60 commit-eligible files; configured secrets not detected (not a universal secret detector).
- Actual stdio `liara_create_app` with old ir-small/basic request: blocked at fresh catalog validation, before approval/POST. This is a negative read-only validation check, not a new failed provider create request.
- Successful create was later verified (see top section); deployment remains unverified. `available:true` did not by itself guarantee acceptance — the earlier g2 attempt lacked the network.

## Latest live continuation (supersedes historical network blocker below)
- Read-only preflight: **4/4 HTTP 200** after owner hosts update; `.agate/preflight-1792678971580.json` is the latest rerun before resource creation.
- Actual MCP stdio `deploy_project` used for plan proposal and create approval requests.
- Three separately approved app-create attempts: `g2_plan_unavailable`, `network_is_required`, then `"bundlePlanID" must be one of [free, basic, standard, pro]`. Each attempt consumed its own approval; no blind retry.
- One separately approved network creation succeeded and was GET-verified. Projects reconciliation still empty. No upload or release write performed.
- Public health GET before the first release: no HTTP status because the hostname did not resolve. Closed. Current `/health` is HTTP 200; see README Current Status. No network code/system changes.
- Build after live shape compatibility fixes: PASS. Final `npm test`: 32 passed, 0 failed (~1.19s). `npm run secret-scan`: 56 commit-eligible files, no configured secrets detected. These checks do not prove successful provider deployment.
- Live deployment acceptance was **NOT_RUN at that moment** because no release existed yet. It was later completed: app status `ACTIVE`, releases `READY`, and `/` + `/health` return HTTP 200. See README Current Status.

Environment: Windows, Node v26.2.0, npm 12.0.2, TypeScript 5.9.x; repository `thecapitalland/Hackaton-Liara`, local working tree based on `471d6f9`. This report describes the changes accompanying it, not a deployed release.

| Claim / command | Result | Evidence / limits |
|---|---|---|
| `npm run build` | PASS | tsc exit 0 after registration wrapper type fix |
| `npm test` | PASS | 31 tests, 31 passed, 0 failed; ~1.84s. Fixtures/mocked API + in-memory MCP, not live provider tests |
| `node demo-site/test.mjs` | PASS | 7 tests, 7 passed; health, healthy home, slow latency, real TypeError/500, leak external-memory growth, admin auth |
| `npm run smoke -- --offline` | PASS (historical) | Real child-process stdio initialization; 31 tools at the time (current: 33), ping; live deliberately skipped |
| `npm run smoke` with configured token | FAIL | stdio passed, live app-list failed before successful authentication |
| `npm run preflight` (repeat at user request) | BLOCKED | 0/4: projects, me, domains, DNS zones. No usable HTTP response; `.agate/preflight-1792674179275.json` |
| DNS diagnosis without credentials | FAIL | Node: EAI_AGAIN for api.iran.liara.ir / api.liara.ir / DNS service; PowerShell: remote name could not be resolved; Code Mode fetch: ENOTFOUND |
| `git check-ignore .env .agate/approvals.json dist/index.js` | PASS | All three ignored |
| `npm run secret-scan` | PASS | 54 commit-eligible files checked; configured keys and private-key markers absent; not a universal secret detector |
| `git diff --check` | PASS | Exit 0; only Windows line-ending notices |
| Browser DOM inspection | PARTIAL | Existing local demo: RTL, health data loaded, viewport 1136px, scrollWidth 1121px |
| Browser screenshot/mobile visual QA | BLOCKED / NOT_RUN | Screenshot tool refused capture because desktop window was not visible; no visual/mobile PASS claimed |
| Mechanical UI detector | WARNINGS FIXED, NOT RERUN | Initial gradient-text / accent-stripe / grid warnings; removed gradient text, disabled stripe/grid pseudo-elements. Not proof of visual quality |
| Live deploy / restart / resize / env / domain / SSL | NOT_RUN | No approval or successful preflight; zero provider mutations by this session |
| Actual VS Code / Cursor / Codex / OpenCode connection | OPENCODE PASS; OTHERS NOT_RUN (historical at the time) | At the time of this early section no IDE was connected. Current: OpenCode 2.1.2 is natively connected and invoked; VS Code/Cursor/Codex remain untested |
| Optional LLM ranking live | NOT_RUN | Credentials configured locally but no live ranking test performed |

Safety coverage: denial sends zero fetch calls; deploy_project on an existing app still requires approval; no writes before preflight; TTL/hash/replay and explicit human grant; env merge preserves existing keys; package excludes secrets; reports parser avoids guessing CPU units; HTTP target/path restrictions; HTTP error mapping and GET-only retry.

Failure history: original demo leak test used heapUsed for Buffers and failed; fixed to inspect external memory as well. A packager test wrongly rejected `.gitignore` and was corrected to reject `.git/`. Initial build wrapper type error fixed and build rerun. These local failures are not hidden as live success.

**Overall at the time of this early section: PARTIAL.** That blocker was resolved later. Current counts and live status are in README **Current Status**, not in this historical paragraph. Live env rollback/remediation remains intentionally NOT_RUN.

## 2026-10-22 — build guard and approval-expiry hardening
| Check | Result | Evidence |
|---|---|---|
| `npm run typecheck` | PASS | src compiles with `--noEmit` |
| `npm run build` | PASS | `dist` refreshed before any guarded run |
| `npm test` | PASS | 44/44; adds no-auto-renew, terminal-state immutability, and `ensureBuild` coverage |
| `scripts/mcp-call.ts ping` | PASS | Build ran first (`npm run build` output precedes MCP response), then stdio ping succeeded |
| Release `6ada364eb3b5ca83e1f16704` | TIMEOUT | Build reached `npm install`; `waitForRelease` 10-min timeout; no deployed version |

The build guard exists because a stale `dist` re-sent the old `build.location:"."` body and reproduced the 400. Expired approvals can no longer be approved or revived: after `expiresAt`, the record becomes `expired` and execution returns `APPROVAL_EXPIRED` with `freshApprovalRequired:true`.

## 2026-10-22 — live verification and release-state fix
| Check | Result | Evidence |
|---|---|---|
| `GET /v1/releases/6ada364eb3b5ca83e1f16704` | READY | nested `release.state`; build finished at 16:14:31 UTC |
| App status | PASS | `isDeployed:true`, `status:ACTIVE`, 4 env keys |
| `GET https://agate-liara.liara.run/health` | PASS | HTTP 200, `status:"ok"`, `bugMode:"off"` |
| `GET https://agate-liara.liara.run/` | PASS | HTTP 200, 10,362 bytes, Agate brand |
| `npm run typecheck` | PASS | after `unwrapRelease()` fix |
| `npm test` | PASS | 45/45, including nested release-state regression |
| Build log evidence | PASS | `up to date in 1s` at 16:14:10; `Successfully built` at 16:14:19; push 100% at 16:14:31 |

The earlier `timeout` was client-side: `releaseState()` did not unwrap `data.release`. Build logs without `since` return only the oldest 20 lines, so the tail appeared stuck at `Running npm install...`. Details: `LESSONS.md`. No new release was created during this verification.

## 2026-10-22 — configurable approval policy

| Check | Result | Evidence |
|---|---|---|
| `npm run typecheck` | PASS | `tsc --noEmit` |
| `npm test` | PASS (historical) | **55/55** at the time. Current counts are in README Current Status |
| `APPROVAL_POLICY` default | PASS | absent/invalid → `strict`; `.env.example` documents all three values |
| `balanced` low-risk path | SUPERSEDED | The legacy `BUG_MODE=off` special case was removed on 2026-10-23. **Current:** `balanced` auto-runs only `low` actions such as `restart`; `rollback_last_env_change` is `medium` and requires approval; `liara_set_env` remains `medium`. |
| High-risk override | PASS (unit) | create app/network, resize, scale remain `high` and require approval in every policy |
| Audit trail | PASS (unit) | `.agate/audit.jsonl` entry records `approval:"auto:balanced"` and the policy notice |

No live provider write was performed for these policy tests. The separate historical leak demo used a one-off approved `BUG_MODE=off`; that is not the current balanced policy.

## 2026-10-22 — diagnosis honesty / blind-input guard

| Check | Result | Evidence |
|---|---|---|
| `npm run typecheck` | PASS | `tsc -p tsconfig.json --noEmit` |
| `npm test` | PASS | **59/59**; adds four honesty/guard checks in `test/diagnosis-honesty.test.ts` |
| Prompt leakage test | PASS | `buildLlmPrompt` output contains no `BUG_MODE`, `bugMode`, or injected mode value (`error500`) |
| Env values/keys | NOT USED | `gatherDiagnosis` passes `env:null`; no project env values or project env key list is read from the API. Only audit/release metadata for the existence/time of an env change is used locally to choose a remedy; neither values nor keys are sent to detectors or the LLM. |
| `/health` body | NOT USED | `diagnose` probes `/` and uses status/latency only; `httpProbe` reads and discards the body without parsing |
| Live read-only diagnosis | PASS (historical) | `inc_e7699495` returned `diagnosisInputExcludes:["env","BUG_MODE","health.body"]`; evidence sources were metrics/events/probe, no env values. This healthy run had no hypotheses, so rules/`inconclusive` was returned and LLM was intentionally not called. |
| Exact prompt inspection | PASS (historical) | `.agate/show-prompt.ts` printed system/user prompt; only app, symptom, legal candidate causes, evidence, allowed remedy ids, and `JSON خروجی:` are present. The current prompt includes the two allowed remedy ids only when applicable. |

This is a local/unit verification plus one read-only live diagnosis. No live provider mutation was made for the honesty tests. The blind test itself waits for a separately injected mode and is not claimed as passed.

## 2026-10-22 — watch_app / npm run watch

| Check | Result | Evidence |
|---|---|---|
| `npm run typecheck` | PASS | `tsc -p tsconfig.json --noEmit` |
| `npm test` | PASS (historical) | **87/87** at the time. Current counts are in README Current Status |
| `npm run build` | PASS | `dist` refreshed |
| `npm run secret-scan` | PASS | 76 commit-eligible files in the final run; configured secrets/private-key markers absent (not a universal detector) |
| `npm run smoke -- --offline` | PASS | Real stdio handshake, discovers **33 tools**, ping; live deliberately skipped |
| Watch thresholds | PASS (unit) | 500 rate strictly >5%, p50 strictly >1500ms, new OOM/restart/crash; exact thresholds do not trigger |
| Metrics summary | PASS (unit + live) | Official `cpuUsage`/`memoryUsage` array shape parsed; raw units are not guessed |
| Cooldown | PASS (unit) | Same fingerprint suppressed within cooldown; a different incident is still reported; first run seeds the event watermark |
| Audit mapping | PASS (unit) | `watch_incident` records `pending`, `approved`, `auto:balanced`, or `not-required` |
| Approval policy | PASS (unit) | `strict` requires approval; `balanced` auto-runs only `low` actions such as `restart`; `rollback_last_env_change` is now `medium` and requires approval. The legacy `BUG_MODE=off` exception was removed |
| Live `npm run watch -- --once` | PASS (read-only) | All three routes HTTP 200, 0/9 500s, max p50 1163ms, metrics summary present, no new incident |
| Live remediation | NOT_RUN | `APPROVAL_POLICY=strict`; the healthy live run had no trigger and performed zero provider mutations |

During live validation, a release-lifecycle `destroy` event was initially classified as a restart and produced one incident with no diagnosis hypothesis. The classifier was narrowed to explicit OOM/restart/crash signals; bare `kill`/`destroy`/`stop`/`die` are now ignored because Liara emits them during ordinary release turnover. A regression test covers this. The erroneous incident remains in the local append-only audit log as a truthful record; no audit entry was deleted.

The 2026-10-23 generalization replaces the old demo-specific `BUG_MODE=off` remedy with `rollback_last_env_change`. The watcher now receives the same 9 probe samples and the same cycle's events that produced the trigger, searches a 10-minute incident window, and offers the LLM only `restart` plus an exact revertable rollback when the local journal has before/after values. If the journal is missing, the change is newer than the incident, or current env no longer matches the recorded `after`, the rollback is refused and `restart` is used/suggested. Live mutation of env was not exercised; the live watcher run above was healthy and read-only.
