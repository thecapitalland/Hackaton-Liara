import { config } from './config.js';

export function redact(value: unknown, key = ''): any {
  if (/^(envs|variables|vars|value|values|token|authorization|password|secret|apikey|api_key)$/i.test(key)) return '••••';
  if (typeof value === 'string') {
    let safe = value;
    for (const secret of [config.token, config.llmApiKey].filter(Boolean)) safe = safe.split(secret).join('••••');
    return safe.replace(/Bearer\s+[^\s"']+/gi, 'Bearer ••••');
  }
  if (Array.isArray(value)) return value.map(v => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,redact(v,k)]));
  return value;
}
