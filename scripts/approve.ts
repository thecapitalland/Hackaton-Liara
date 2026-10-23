import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { getApproval, setApprovalStatus, validateApproval } from '../src/approval.js';
import { writeAudit } from '../src/audit.js';

const id = process.argv[2] ?? '';
const rec = getApproval(id);
const check = rec ? validateApproval(rec) : { ok: false as const, reason: 'درخواست تأیید پیدا نشد.' };
if (!rec || !check.ok || rec.status !== 'pending') {
  console.error(`❌ ${check.ok ? 'درخواست در وضعیت «معلق» نیست؛ تأیید دوباره ممکن نیست.' : check.reason}`);
  process.exitCode = 1;
} else {
  console.log(`${rec.summaryFa}\n⚠️ ${rec.impact}\nهش: ${rec.hash}`);
  const planChoices = rec.choices.filter((choice) => choice.value !== 'cancel' && choice.value !== 'approve');
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = planChoices.length
    ? await rl.question('برای پلن پیشنهادی دقیقاً yes بنویسید؛ برای گزینهٔ دیگر همان مقدار کارت را بنویسید؛ هر پاسخ دیگر = لغو: ')
    : await rl.question('برای تأیید دقیقاً yes بنویسید؛ هر پاسخ دیگر = لغو: ');
  rl.close();
  const selected = planChoices.find((choice) => choice.value === answer);
  const recommended = planChoices.find((choice) => choice.recommended) ?? planChoices[0];
  const approved = answer === 'yes' || Boolean(selected);
  setApprovalStatus(id, approved ? 'approved' : 'rejected', answer === 'yes' ? recommended?.value : selected?.value);
  writeAudit({ ts: new Date().toISOString(), tool: 'human_approval', app: rec.app, approval: approved ? 'approved' : 'rejected', result: approved ? 'ok' : 'rejected', durationMs: 0 });
  console.log(approved ? '✅ تأیید ثبت شد؛ اکنون execute_action را صدا بزنید.' : '❌ لغو شد؛ هیچ تغییری اعمال نشد.');
}
