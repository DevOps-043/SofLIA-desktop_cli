import { sanitizeLog } from './logging.js';

export const WORKER_LINK_REQUIRED_MESSAGE =
  'Vincula este equipo con un codigo temporal nuevo desde SofLIA.';

function getErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isWorkerLinkRequiredError(error: unknown): boolean {
  const message = getErrorText(error);
  return (
    message.includes('Config incompleta') ||
    (/^HTTP 401:/i.test(message) && /worker token|invalid or revoked/i.test(message))
  );
}

export function getWorkerStatusMessage(error: unknown): string | undefined {
  if (isWorkerLinkRequiredError(error)) return undefined;
  return sanitizeLog(getErrorText(error));
}

export function getWorkerStartMessage(error: unknown): string {
  if (isWorkerLinkRequiredError(error)) return WORKER_LINK_REQUIRED_MESSAGE;
  return sanitizeLog(getErrorText(error));
}
