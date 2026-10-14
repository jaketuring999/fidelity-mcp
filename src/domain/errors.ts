import type { FailureCode } from '../bridge/protocol.js';

type ErrorCode =
  | 'BROWSER_CONNECTION_FAILED'
  | 'BROWSER_LAUNCH_FAILED'
  | 'BROWSER_DISCONNECTED'
  | FailureCode
  | 'INVALID_BRIDGE_RESPONSE';

export class FidelityError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FidelityError';
  }
}
