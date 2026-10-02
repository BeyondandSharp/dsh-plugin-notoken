// Failure notifier: run by the workflow's `if: failure()` step when an earlier
// step aborted the release before it could report a result.
//
// It only has an authentication URL to send when the failure carried one (the
// relay refuses anything else), so a plain crash stays silent on purpose.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayload, deliver, errorSummary } from './notify-lib.mjs';

// Run directly (argv[1] is this file) rather than imported by a test.
// Compare real paths: /tmp is a symlink on some hosts, and path.resolve
// would then disagree with import.meta.url.
export const IS_DIRECT = (() => {
  if (!process.argv[1] || !process.argv[1].endsWith('.mjs')) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

async function main() {
  const temp = process.env.RUNNER_TEMP || '/tmp';
  const corePath = join(temp, 'release.json');
  const core = existsSync(corePath) ? JSON.parse(readFileSync(corePath, 'utf8')) : {};
  const payload = buildPayload({
      phase: 'failed',
      core,
      reason: '工作流在发布完成前失败，请查看 run 日志',
  });

  try {
    const result = await deliver(payload);
    if (result.skipped) {
      process.stdout.write(`无需通知：${result.reason}\n`);
    } else {
      process.stdout.write(`已投递失败通知（${payload.url}）\n`);
    }
  } catch (error) {
    process.stderr.write(`失败通知投递失败：${errorSummary(error)}\n`);
  }
}

if (IS_DIRECT) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`失败通知异常：${errorSummary(error)}\n`);
  }
}
