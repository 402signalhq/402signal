import type { RecoveryScope, SessionResponse, SendSession, RecoverSession } from './common.js';
/** Receipt lookup must read an existing acknowledgment, never retry the payment endpoint. */
export interface SessionTransportOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly readReceipt?: (scope: RecoveryScope) => Promise<SessionResponse>;
}
export function createSessionTransport(options?: SessionTransportOptions): Readonly<{ send: SendSession; recover: RecoverSession }>;
