import { config } from './config.js';

/**
 * ماسک الگوهای رایج راز در متن غیرقابل‌اعتماد (لاگ و پرامپت).
 * شناسه‌های کوتاه‌تر از ۳۲ رقم هگز، مثل release id، دست نمی‌خورند.
 */
export function redactSecrets(text: string): string {
  let safe = text;
  safe = safe.replace(
    /\b(password|passwd|secret|token|api[_-]?key)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"',}]+)/gi,
    "$1$2••••",
  );
  safe = safe.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "••••");
  safe = safe.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "••••");
  safe = safe.replace(/\b[A-Fa-f0-9]{32,}\b/g, "••••");
  safe = safe.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "••••");
  return safe;
}

export function redact(value: unknown, key = ''): any {
  if (/^(envs|variables|vars|value|values|token|authorization|password|secret|apikey|api_key)$/i.test(key)) return '••••';
  if (typeof value === 'string') {
    let safe = redactSecrets(value);
    for (const secret of [config.token, config.llmApiKey].filter(Boolean)) safe = safe.split(secret).join('••••');
    return safe.replace(/Bearer\s+[^\s"']+/gi, 'Bearer ••••');
  }
  if (Array.isArray(value)) return value.map(v => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,redact(v,k)]));
  return value;
}
