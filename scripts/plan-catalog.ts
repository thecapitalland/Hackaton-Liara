import { writeFileSync } from 'node:fs';
import { fetchPlanCatalog } from '../src/liara/plans.js';

const catalog = await fetchPlanCatalog();
writeFileSync('docs/PLAN_CATALOG_LIVE.json', JSON.stringify(catalog.plans ? {plans:catalog.plans} : {},null,2)+'\n','utf8');
console.log(JSON.stringify({
  source:'GET /v1/me with configured teamID; no token in artifact',
  snapshot:'docs/PLAN_CATALOG_LIVE.json',
  planKeys:Object.keys(catalog.plans.projects),
  exactBundleKeys:Object.fromEntries(Object.entries(catalog.plans.projectBundlePlans).map(([id,b]) => [id,Object.keys(b)])),
  exclusions:catalog.exclusions,
  top3:catalog.pairs.slice(0,3),
},null,2));
