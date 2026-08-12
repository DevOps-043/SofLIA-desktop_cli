import { openBrowser } from '@remotion/renderer';
import type { WorkerChromiumGl } from './shared/worker-capacity.js';

type RemotionBrowser = Awaited<ReturnType<typeof openBrowser>>;

/** Reuses one Chromium process for composition discovery and frame rendering. */
export async function withRemotionBrowser<T>(
  chromiumGl: WorkerChromiumGl | undefined,
  task: (browser: RemotionBrowser) => Promise<T>,
): Promise<T> {
  const browser = await openBrowser('chrome', {
    chromiumOptions: chromiumGl ? { gl: chromiumGl } : undefined,
  });
  try {
    return await task(browser);
  } finally {
    await browser.close({ silent: true }).catch(() => undefined);
  }
}
