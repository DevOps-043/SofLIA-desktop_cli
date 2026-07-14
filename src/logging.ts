export function sanitizeLog(value: unknown): string {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/swk_[A-Za-z0-9._~+/=-]+/gi, 'swk_[redacted]')
    .replace(/SLIA-\d{6}/gi, 'SLIA-[redacted]')
    .replace(/([?&](?:token|signature|expires|apikey|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/SUPABASE_SERVICE_ROLE_KEY=[^\s]+/gi, 'SUPABASE_SERVICE_ROLE_KEY=[redacted]');
}

export function log(message: string, details?: unknown): void {
  try {
    if (details === undefined) {
      console.log(message);
      return;
    }
    console.log(message, sanitizeLog(JSON.stringify(details)));
  } catch {
    // Electron/packaged apps may not always have a writable stdout pipe.
  }
}

export function logError(message: string, error: unknown): void {
  try {
    console.error(message, sanitizeLog(error instanceof Error ? error.message : String(error)));
  } catch {
    // Best-effort logging only.
  }
}
