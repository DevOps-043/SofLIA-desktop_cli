export class RecoverableJobError extends Error {
  constructor(
    message: string,
    readonly stage: 'upload' | 'complete',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RecoverableJobError';
  }
}

export function isRecoverableJobError(error: unknown): error is RecoverableJobError {
  return error instanceof RecoverableJobError;
}
