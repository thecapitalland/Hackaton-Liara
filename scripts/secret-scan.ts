import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';

const files = [...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean))];
const secrets = [config.token,config.llmApiKey,process.env.ADMIN_KEY].filter((s): s is string => Boolean(s && s.length >= 8));
const hits: string[] = [];
for (const file of files) {
  const text = readFileSync(file,'utf8');
  if (secrets.some(s => text.includes(s)) || /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) hits.push(file);
}
if (hits.length) {
  console.error('FAIL: مقادیر حساس در فایل‌های قابل commit؛ فقط مسیرها:',...hits);
  process.exitCode = 1;
} else console.log(`PASS: ${files.length} فایل قابل commit؛ کلیدهای تنظیم‌شده و private-key marker یافت نشد. این اسکن تضمین کشف همهٔ اسرار دلخواه نیست.`);
