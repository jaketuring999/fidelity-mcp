import type { FailureCode } from '../bridge/protocol.js';

type ErrorCode =
  | FailureCode
  | 'EXTENSION_DISCONNECTED'
  | 'BRIDGE_IN_USE'
  | 'BRIDGE_TIMEOUT'
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
