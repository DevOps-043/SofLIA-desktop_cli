export function sanitizeLog(value: unknown): string {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/swk_[A-Za-z0-9._~+/=-]+/gi, 'swk_[redacted]')
    .replace(/([?&](?:token|signature|expires|apikey|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/SUPABASE_SERVICE_ROLE_KEY=[^\s]+/gi, 'SUPABASE_SERVICE_ROLE_KEY=[redacted]');
}

export function log(message: string, details?: unknown): void {
  if (details === undefined) {
    console.log(message);
    return;
  }
  console.log(message, sanitizeLog(JSON.stringify(details)));
}

export function logError(message: string, error: unknown): void {
  console.error(message, sanitizeLog(error instanceof Error ? error.message : String(error)));
}
