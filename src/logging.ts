import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAppDataDir } from './paths.js';

const LOG_DIR_NAME = 'logs';
const WORKER_LOG_FILE = 'worker.log';
const ERROR_LOG_FILE = 'error.log';
const MAX_LOG_LINE_LENGTH = 20_000;

function getLogDir(): string {
  return path.join(getAppDataDir(), LOG_DIR_NAME);
}

export function getWorkerLogPath(): string {
  return path.join(getLogDir(), WORKER_LOG_FILE);
}

export function getErrorLogPath(): string {
  return path.join(getLogDir(), ERROR_LOG_FILE);
}

export function sanitizeLog(value: unknown): string {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/swk_[A-Za-z0-9._~+/=-]+/gi, 'swk_[redacted]')
    .replace(/SLIA-\d{6}/gi, 'SLIA-[redacted]')
    .replace(/([?&](?:token|signature|expires|apikey|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/SUPABASE_SERVICE_ROLE_KEY=[^\s]+/gi, 'SUPABASE_SERVICE_ROLE_KEY=[redacted]');
}

function truncateLogLine(value: string): string {
  if (value.length <= MAX_LOG_LINE_LENGTH) return value;
  return `${value.slice(0, MAX_LOG_LINE_LENGTH)}... [truncated]`;
}

function formatLogLine(level: 'INFO' | 'ERROR', message: string, details?: unknown): string {
  const timestamp = new Date().toISOString();
  const detailText = details === undefined
    ? ''
    : ` ${sanitizeLog(typeof details === 'string' ? details : JSON.stringify(details))}`;
  return truncateLogLine(`[${timestamp}] [${level}] ${sanitizeLog(message)}${detailText}`);
}

function appendLogFile(filePath: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch {
    // Best-effort logging only. The app must keep running if disk logging fails.
  }
}

function appendWorkerLog(line: string): void {
  appendLogFile(getWorkerLogPath(), line);
}

function appendErrorLog(line: string): void {
  appendLogFile(getErrorLogPath(), line);
}

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

export function log(message: string, details?: unknown): void {
  const line = formatLogLine('INFO', message, details);
  appendWorkerLog(line);
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
  const line = formatLogLine('ERROR', message, getErrorDetails(error));
  appendWorkerLog(line);
  appendErrorLog(line);
  try {
    console.error(message, sanitizeLog(error instanceof Error ? error.message : String(error)));
  } catch {
    // Best-effort logging only.
  }
}
