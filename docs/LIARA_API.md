# Liara API registry

**Evidence:** initial implementation prompt + official `liara-cloud/openapi/spec/paas.yaml` inspected through GitHub on 2026-10-22. The `openapi.liara.ir/paas.yaml` host could not be fetched in this environment. Live preflight later passed **4/4** after the owner fixed hosts, and an app create was live-verified (see “Successful live create”). Never confuse documentation with live verification.

Sources: [PaaS spec](https://github.com/liara-cloud/openapi/blob/master/spec/paas.yaml), [DNS spec](https://github.com/liara-cloud/openapi/blob/master/spec/dns.yaml), [official CLI](https://github.com/liara-cloud/cli). Resolve the repository's current default branch if `master` changes.

Auth: `Authorization: Bearer <LIARA_API_TOKEN>`; append `teamID=<id>` when configured. PaaS default `https://api.iran.liara.ir`, GET fallback `https://api.liara.ir`. DNS default `https://dns-service.iran.liara.ir`, fallback `https://dns-service.liara.ir`. Timeout 20s; one retry for transient GET only. No blind retry for mutations.

| Method | Path | Purpose / request |
|---|---|---|
| GET | `/v1/projects` | List apps |
| POST | `/v1/projects` | Live-verified create: `{name,planID,platform,bundlePlanID,network}` — all five accepted together; returns `{projectID}` |
| GET | `/v1/projects/{name}` | Project details |
| GET | `/v1/me` | Account + `plans.projects`, `plans.projectBundlePlans` (CLI reference; no separate plans endpoint) |
| POST | `/v2/projects/{name}/sources` | multipart `file` tar.gz, ≤256 MiB; `{sourceID}` |
| POST | `/v2/projects/{name}/releases` | `{sourceID,port,type,build,...}`; `{releaseID}` |
| GET | `/v1/releases/{releaseID}` | Release polling (CLI reference) |
| GET | `/v2/releases/{releaseID}/build-logs?since=<ts>` | Build logs (CLI reference) |
| POST | `/v2/releases/{releaseID}/cancel` | Cancel (reference only, not exposed as tool) |
| GET | `/v1/projects/{name}/releases` | Releases |
| POST | `/v1/projects/update-envs` | `{project,variables:[{key,value}]}`; full-list replacement + restart; read/merge/write required |
| POST | `/v1/projects/{name}/actions/restart` | Restart |
| POST | `/v1/projects/{name}/actions/scale` | `{scale:0\|1}` |
| POST | `/v1/projects/{name}/resize` | `{planID}` |
| POST | `/v1/projects/update-port` | CLI reference; no public tool yet |
| GET | `/v1/projects/{name}/logs?since=<ts>` | v1 logs |
| GET | `/v2/projects/{name}/logs?start=&direction=forward&last_lines=&releaseId=` | CLI logs reference, polling |
| GET | `/v1/projects/{name}/events` | Events |
| GET | `/v1/projects/{name}/metrics/summary` | Summary |
| GET | `/v1/projects/{name}/metrics/cpu?since=<n>` | CPU series; units to confirm live |
| GET | `/v1/projects/{name}/metrics/memory?since=<n>` | RAM series; units to confirm live |
| GET | `/v1/projects/{name}/metrics/network-receive`, `/network-transmit` | Network; no standalone tool yet |
| GET | `/v1/domains?project=<app>` | Domains |
| POST | `/v1/domains` | `{name,project,type:"PROJECT"}` |
| GET | `/v1/domains/{id}/check` | DNS check |
| POST | `/v1/domains/provision-ssl-certs` | `{domain}` |
| GET/POST (DNS) | `/api/v1/zones` | Only GET currently used by preflight |
| PUT (DNS) | `/api/v1/zones/{zone}/check` | Reference only |
| GET/POST/PUT/DELETE (DNS) | `/api/v1/zones/{zone}/dns-records[/{id}]` | Reference only; not implemented as mutation tools |

## Shapes verified in the official schema, not live

- List projects: `{projects:[{_id,project_id,type,status,scale,planID,created_at,isDeployed}]}`. `project_id` is the human app name.
- Project details: `{project:{...,envs:[{key,value,encrypted,_id}],planID,...}}`. Do not return env values to the host/LLM.
- Domains: `{domains:[{_id,name,type,project,status,certificatesStatus,...}]}`.
- Upload: `{sourceID:string}`; create release: `{releaseID:string}`.
- Logs v1: array of `{type,datetime,message}`. Additional v2 shapes need live confirmation.
- Spec Create-app contains name/planID/platform/network/readOnlyRootFilesystem. Prompt/CLI mention bundlePlanID; no bundle is guessed or silently selected.

## Live preflight protocol

### Live update · 2026-10-22 14:04 UTC

After the owner manually updated Windows hosts, authenticated GET preflight passed **4/4**: projects `{projects:[]}`, me `{user,team,databaseVersions,defaultDatabaseVersions,featureFlags,plans}`, domains `{domains:[],total}`, DNS zones `{status,data:[]}`. Existing-app endpoints cannot be tested before creating an app. The earlier DNS failure above is historical.

`plans.projects` is an object keyed by plan ID, not an array. Each plan includes `available`, `region`, `RAM:{amount,shared}`, `CPU:{amount,shared}`, `price` and (g2) `displayPrice`. Official CLI interprets RAM.amount as GB and CPU.amount as cores; `price * 720` and `displayPrice` are Tomans/month. `plans.projectBundlePlans[planID][bundlePlanID]` carries a separate price. Show and approve the combined resources+bundle cost. CLI create body explicitly includes `bundlePlanID`.

First approved create: `small-g2/basic` returned provider error `g2_plan_unavailable` despite `available:true` in GET /v1/me. Reconciled GET /v1/projects remains empty; no automatic retry/plan substitution. Owner separately approved legacy `ir-small/default` (hourly 1319.44 Tomans). Legacy bundle definitions come from `plans.projectBundlePlans.g1.default`.

Second approved create (`ir-small/default`, without network) returned `network_is_required`. Official CLI `src/base.ts` confirms GET `/v1/networks` → `{networks:[...]}`, and `src/commands/network/create.ts` confirms POST `/v1/networks` with `{networkName}`. Live GET returned `{networks:[]}`. App creation requires `network:<network._id>` for this team; although previously optional in the source table, it is required by the live API. Owner separately approved creating network `agate-liara`. No host/DNS/transport changes by the agent.

Approved network creation succeeded: response `{network:{_id}}`; reconciliation GET returned `{networks:[{_id,name,createdAt,projectCount,databaseCount}]}`. Subsequent separately-approved app create with that network and `ir-small/default` failed with `"bundlePlanID" must be one of [free, basic, standard, pro]`. This conflicts with the live legacy bundle listing `g1.default`; no alternative bundle is silently selected. An `ir-small/basic` retry failed with `g1_plan_unavailable`.

**Successful live create (15:38 UTC):** exact body `{name:"agate-liara",planID:"small-g2",bundlePlanID:"basic",platform:"node",network:"6ada1e64b3b5ca83e1ee0ce1"}` → `200 {"projectID":"6ada2dd838253e6cdf2b836e"}`. Reconciliation `GET /v1/projects` returned one app with `status ACTIVE`, `planID small-g2`, `bundlePlanID basic`, that network, and `isDeployed:false`. The earlier g2 failure had been sent without a network; `network` and `bundlePlanID` are both required by the live API for this team. This does not prove upload/release success or service health.

Public health request failed with Node DNS `ENOTFOUND agate-liara.liara.run` (no HTTP response), before any release existed. No network workaround applied, as instructed by the owner. This result is historical and must be re-tested after deployment.

### Strict catalog contract (latest)

`src/liara/plans.ts` filters `plans.projects` with `available === true && region === "iran"`, then joins bundles **only** at `plans.projectBundlePlans[planID]`, keeping bundles with `available === true`. Legacy `g1.default` is not a same-key match for `ir-small` and is no longer a fallback. Unknown prices are excluded. Candidates are sorted by sum of resource and bundle monthly prices (`displayPrice`, otherwise numeric `price * 720`, as in official CLI).

Exact filtered API JSON (without user/team/token fields): `docs/PLAN_CATALOG_LIVE.json`. API-advertised candidates do not imply POST permission or guaranteed service acceptance. Create and propose fetch a server-side quote; execution re-fetches and validates the exact pair and price components before POST. Older approvals without a quote are rejected. No automatic retry with alternative bundles.

Run `npm run preflight` from repository cwd with private `.env`. GETs only: project list, account/plans, existing allowlisted app details/logs v1+v2/events/metrics/domains/releases, all domains, DNS zones. No production apps outside the allowlist are inspected for app-level data.

Output prints HTTP codes and keys/types, never Authorization or env values. Local report: `.agate/preflight-<timestamp>.json`; documentation summary: `docs/PREFLIGHT_LATEST.md` (created only after an actual run). Gate receipt: `.agate/preflight-gate.json`, bound to connection digest, 24h TTL, invalid after token/team/base changes. Any unexplained endpoint failure keeps the gate closed.

Before enabling writes, reconcile endpoint paths, envelope shape, time-window format, metric units and account permission errors with this table. A GET-only preflight cannot prove POST behavior: record release IDs and verification separately after explicit approval.

401/403 → Persian auth error; 404 → app-not-found; 429 → Persian rate-limit guidance. Unknown write result is not proof of completion. Rollback, streaming logs, dedicated plans endpoint, health-check endpoint, domain registration and direct GitHub deploy remain explicit limitations.
