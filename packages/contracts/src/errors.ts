import { z } from 'zod';

export const FlowTraceErrorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN_ORG_MISMATCH',
  'RESOURCE_NOT_FOUND',
  'CLAIM_CONFLICT',
  'LEASE_EXPIRED',
  'INVALID_PAYLOAD',
  'EXECUTION_CANCELLED',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'TOO_MANY_REQUESTS',
  'CALLBACK_REJECTED',
  'INTERNAL_ERROR'
]);

export type FlowTraceErrorCode = z.infer<typeof FlowTraceErrorCodeSchema>;

export const FlowTraceErrorPayloadSchema = z.object({
  code: FlowTraceErrorCodeSchema,
  message: z.string(),
  details: z.record(z.any()).optional(),
  timestamp: z.string().datetime()
});

export type FlowTraceErrorPayload = z.infer<typeof FlowTraceErrorPayloadSchema>;

export class FlowTraceError extends Error {
  public readonly code: FlowTraceErrorCode;
  public readonly details?: Record<string, any>;
  public readonly statusCode: number;

  constructor(code: FlowTraceErrorCode, message: string, statusCode = 500, details?: Record<string, any>) {
    super(message);
    this.name = 'FlowTraceError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, FlowTraceError.prototype);
  }

  toJSON(): FlowTraceErrorPayload {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      timestamp: new Date().toISOString()
    };
  }
}
