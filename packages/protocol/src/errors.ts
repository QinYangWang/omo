/**
 * Stable protocol error codes. Unknown control errors must be rejected, never
 * degraded silently (plan §6.3: 未知控制指令必须拒绝).
 */
export const OMO_ERROR_CODES = [
  "unauthenticated",
  "permission_denied",
  "daemon_offline",
  "unknown_command",
  "unknown_schema",
  "payload_schema_unsupported",
  "duplicate_payload_mismatch",
  "revision_mismatch",
  "operation_mismatch",
  "quota_exceeded",
  "reset_required",
  "writer_conflict",
  "storage_unavailable",
  "internal",
] as const;

export type OmoErrorCode = (typeof OMO_ERROR_CODES)[number];

export interface OmoError {
  code: OmoErrorCode;
  message: string;
  /** True when the same command may be retried unchanged (e.g. backpressure). */
  retryable: boolean;
}

export const omoError = (
  code: OmoErrorCode,
  message: string,
  retryable = false
): OmoError => ({ code, message, retryable });

export class OmoCommandError extends Error {
  readonly code: OmoErrorCode;
  readonly retryable: boolean;

  constructor(code: OmoErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "OmoCommandError";
    this.code = code;
    this.retryable = retryable;
  }
}
