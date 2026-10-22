# Verification evidence · 2026-10-22

Environment: Windows, Node v26.2.0, npm 12.0.2, TypeScript 5.9.x; repository `thecapitalland/Hackaton-Liara`, local working tree based on `471d6f9`. This report describes the changes accompanying it, not a deployed release.

| Claim / command | Result | Evidence / limits |
|---|---|---|
| `npm run build` | PASS | tsc exit 0 after registration wrapper type fix |
| `npm test` | PASS | 31 tests, 31 passed, 0 failed; ~1.84s. Fixtures/mocked API + in-memory MCP, not live provider tests |
| `node demo-site/test.mjs` | PASS | 7 tests, 7 passed; health, healthy home, slow latency, real TypeError/500, leak external-memory growth, admin auth |
| `npm run smoke -- --offline` | PASS | Real child-process stdio initialization, list 31 tools, ping; live deliberately skipped |
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
| Actual VS Code / Cursor / Codex / OpenCode connection | NOT_RUN | Config formats checked against current official docs; standalone stdio smoke is not IDE validation |
| Optional LLM ranking live | NOT_RUN | Credentials configured locally but no live ranking test performed |

Safety coverage: denial sends zero fetch calls; deploy_project on an existing app still requires approval; no writes before preflight; TTL/hash/replay and explicit human grant; env merge preserves existing keys; package excludes secrets; reports parser avoids guessing CPU units; HTTP target/path restrictions; HTTP error mapping and GET-only retry.

Failure history: original demo leak test used heapUsed for Buffers and failed; fixed to inspect external memory as well. A packager test wrongly rejected `.gitignore` and was corrected to reject `.git/`. Initial build wrapper type error fixed and build rerun. These local failures are not hidden as live success.

**Overall: PARTIAL.** Local functional checks pass; live integration acceptance is blocked by name resolution. See LIMITATIONS.md for unimplemented DNS mutation and other gaps. Do not record a successful live demo until preflight, approvals and post-action checks succeed.
