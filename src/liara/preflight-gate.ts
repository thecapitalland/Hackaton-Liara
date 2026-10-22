import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export function connectionDigest(): string {
  return createHash('sha256').update(JSON.stringify([config.apiBase,config.dnsBase,config.teamId,config.token])).digest('hex');
}

/** No provider mutation before a successful authenticated read-only preflight. */
export function assertPreflight(): void {
  try {
    const receipt = JSON.parse(readFileSync(path.join(config.stateDir,'preflight-gate.json'),'utf8'));
    if (receipt.connection === connectionDigest() && receipt.ready === true &&
        Date.now() - Date.parse(receipt.ranAt) < 24 * 60 * 60_000) return;
  } catch { /* fail closed */ }
  throw new Error('❌ ابتدا npm run preflight را با همین حساب و تیم اجرا و اختلاف‌های API را بررسی کنید؛ هیچ تغییری اعمال نشد.');
}
