/**
 * گارد اجرای dist: قبل از هر بار اجرای `dist/index.js` همیشه `npm run build` اجرا می‌شود
 * تا هرگز کد قدیمی (stale) اجرا نشود. اگر build شکست بخورد، اجرای dist متوقف می‌شود.
 */
import { spawnSync } from 'node:child_process';

export interface BuildResult {
  status: number | null;
  error?: Error;
}

/** تزریق‌پذیر برای تست؛ پیش‌فرض همان دستور واقعی build است. */
export type BuildRunner = () => BuildResult;

function defaultRunner(): BuildResult {
  // رشتهٔ ثابت و بدون ورودی کاربر؛ shell فقط برای یافتن npm در ویندوز لازم است.
  return spawnSync('npm run build', {
    stdio: 'inherit',
    shell: true,
  });
}

export function ensureBuild(run: BuildRunner = defaultRunner): void {
  const result = run();
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `❌ npm run build پیش از اجرا شکست خورد (exit ${String(result.status)}); اجرای dist متوقف شد.`,
    );
  }
}
