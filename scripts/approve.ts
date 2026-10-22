import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { getApproval, setApprovalStatus, validateApproval } from '../src/approval.js';
import { writeAudit } from '../src/audit.js';

const id = process.argv[2] ?? '';
const rec = getApproval(id);
if (!rec || !validateApproval(rec).ok || rec.status !== 'pending') {
  console.error('❌ درخواست معتبر و معلق پیدا نشد.');
  process.exitCode = 1;
} else {
  console.log(`${rec.summaryFa}\n⚠️ ${rec.impact}\nهش: ${rec.hash}`);
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question('برای تأیید دقیقاً yes بنویسید؛ هر پاسخ دیگر = لغو: ');
  rl.close();
  const approved = answer === 'yes';
  setApprovalStatus(id, approved ? 'approved' : 'rejected');
  writeAudit({ ts: new Date().toISOString(), tool: 'human_approval', app: rec.app, approval: approved ? 'approved' : 'rejected', result: approved ? 'ok' : 'rejected', durationMs: 0 });
  console.log(approved ? '✅ تأیید ثبت شد؛ اکنون execute_action را صدا بزنید.' : '❌ لغو شد؛ هیچ تغییری اعمال نشد.');
}
