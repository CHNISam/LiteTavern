import type { ErrorCode } from '@litetavern/contracts';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode = 400,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'AppError';
  }
}
