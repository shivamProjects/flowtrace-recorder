import { z } from 'zod';

// ============================================================================
// FlowTrace Zod Schemas & Domain Contracts (V2.1 Ratified)
// ============================================================================

export const StepActionSchema = z.enum([
  'click',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'hover',
  'navigate',
  'assert',
  'wait',
  'custom'
]);

export const StepStatusSchema = z.enum([
  'success',
  'warn',
  'failed',
  'skipped',
  'PASSED',
  'FAILED',
  'SKIPPED',
  'WARN'
]);

export const ExecutionStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'CANCELLING',
  'PASSED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  // Backward compatibility aliases
  'PENDING',
  'REPAIRED',
  'ERRORED'
]);

export const ParameterTypeSchema = z.enum([
  'STRING',
  'NUMBER',
  'BOOLEAN',
  'DATE',
  'PASSWORD',
  'SECRET_REF',
  'LOV_SELECT'
]);

export const ParameterDefSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  type: ParameterTypeSchema.default('STRING'),
  required: z.boolean().default(false),
  defaultValue: z.any().optional(),
  description: z.string().optional(),
  stepIndices: z.array(z.number().int().nonnegative()).default([]),
  lovOptions: z.array(z.string()).optional()
});

export const RecordingStepSchema = z.object({
  index: z.number().int().nonnegative(),
  action: StepActionSchema,
  selector: z.string().min(1),
  value: z.any().optional(),
  url: z.string().optional(),
  label: z.string().optional(),
  section: z.string().optional(),
  timestamp: z.string().optional(),
  screenshotPath: z.string().optional(),
  isParameterized: z.boolean().default(false),
  parameterName: z.string().optional()
});

export const RecordingVersionSchema = z.object({
  id: z.string().uuid().optional(),
  recordingId: z.string().uuid(),
  versionNumber: z.number().int().positive(),
  rawSteps: z.array(RecordingStepSchema),
  normalizedSteps: z.array(RecordingStepSchema).optional(),
  parameterSchema: z.array(ParameterDefSchema).default([]),
  checksum: z.string(),
  patchId: z.string().default('generic'),
  sourceUrl: z.string().optional(),
  stepCount: z.number().int().nonnegative(),
  createdBy: z.string(),
  createdAt: z.string().datetime().optional()
});

export const RecordingSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().min(1),
  applicationId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  currentVersionId: z.string().uuid().nullable().optional(),
  status: z.enum(['ACTIVE', 'DRAFT', 'ARCHIVED']).default('ACTIVE'),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const ExecutionStepResultSchema = z.object({
  id: z.string().uuid().optional(),
  executionId: z.string().uuid(),
  stepIndex: z.number().int().nonnegative(),
  action: z.string(),
  description: z.string().optional(),
  selector: z.string().optional(),
  status: StepStatusSchema,
  durationMs: z.number().int().nonnegative().optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  recovery: z.record(z.any()).optional(),
  viaAi: z.boolean().default(false),
  errorType: z.string().optional(),
  screenshotStorageKey: z.string().optional()
});

export const ExecutionDispatchPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  recordingId: z.string().uuid(),
  versionNumber: z.number().int().positive().optional(),
  environmentId: z.string().uuid(),
  parameterValues: z.record(z.any()).default({}),
  triggerSource: z.enum(['UI', 'API', 'SCHEDULE', 'PLATFORM_CHAIN', 'RELEASE_TEST']).default('API'),
  captureScreenshots: z.boolean().default(true),
  generatePdfReport: z.boolean().default(false),
  externalCorrelationId: z.string().optional(),
  callbackUrl: z.string().url().optional(),
  callbackToken: z.string().optional()
});

export const ExecutionResponseSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string(),
  recordingId: z.string().uuid(),
  recordingVersionId: z.string().uuid().optional(),
  environmentId: z.string().uuid().nullable().optional(),
  status: ExecutionStatusSchema,
  healed: z.boolean().default(false),
  healCount: z.number().int().nonnegative().default(0),
  parameterSnapshot: z.record(z.any()).default({}),
  durationMs: z.number().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  startedAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  externalCorrelationId: z.string().nullable().optional(),
  createdAt: z.string().datetime()
});

export const RepairRecordSchema = z.object({
  id: z.string().uuid().optional(),
  workspaceId: z.string(),
  recordingId: z.string().uuid(),
  stepIndex: z.number().int().nonnegative(),
  brokenSelector: z.string(),
  repairedSelector: z.string(),
  recoveryStrategy: z.string(),
  confidenceScore: z.number().min(0).max(1).optional(),
  evidence: z.record(z.any()).default({}),
  status: z.enum(['PENDING_REVIEW', 'APPROVED', 'AUTO_APPLIED', 'REJECTED', 'REVERTED']).default('AUTO_APPLIED'),
  reviewedBy: z.string().optional(),
  reviewedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime().optional()
});

export const CapturedOutputSchema = z.object({
  id: z.string().uuid().optional(),
  executionId: z.string().uuid(),
  stepIndex: z.number().int().nonnegative(),
  outputName: z.string().min(1),
  outputValue: z.string(),
  dataType: z.string().default('STRING'),
  createdAt: z.string().datetime().optional()
});

// ============================================================================
// Worker Claim & Dispatch Contracts (Model A: runs as durable queue)
// ============================================================================

export const WorkClaimRequestSchema = z.object({
  workerNodeId: z.string().min(1),
  supportedEngines: z.array(z.string()).default(['playwright']),
  maxConcurrent: z.number().int().positive().default(1)
});

export const WorkClaimRunDetailsSchema = z.object({
  runId: z.string().uuid(),
  orgId: z.string().uuid(),
  recordingId: z.string().uuid(),
  recordingVersionId: z.string().uuid().optional(),
  environmentId: z.string().uuid().nullable().optional(),
  parameterValues: z.record(z.any()).default({}),
  rawSteps: z.array(RecordingStepSchema),
  normalizedSteps: z.array(RecordingStepSchema).optional(),
  baseUrl: z.string().url().optional(),
  executionToken: z.string(),
  leaseExpiresAt: z.string().datetime()
});

export const WorkClaimResponseSchema = z.object({
  claimed: z.boolean(),
  run: WorkClaimRunDetailsSchema.nullable().optional()
});

// ============================================================================
// Reconciled Callback Contracts (Worker -> Control Plane)
// ============================================================================

export const StepCallbackPayloadSchema = z.object({
  runId: z.string().uuid(),
  stepIndex: z.number().int().nonnegative(),
  action: z.string(),
  status: z.enum(['PASSED', 'FAILED', 'SKIPPED', 'WARN', 'passed', 'failed', 'skipped', 'warn']),
  durationMs: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  errorType: z.string().optional(),
  failureStage: z.string().optional(),
  screenshotKey: z.string().optional(),
  screenshotBase64: z.string().optional()
});

export const HealCallbackPayloadSchema = z.object({
  runId: z.string().uuid(),
  stepIndex: z.number().int().nonnegative(),
  healApplied: z.boolean().default(true),
  healMethod: z.string(),
  healConfidence: z.union([z.number(), z.string()]).optional(),
  healFrom: z.string(),
  healTo: z.string(),
  recoveryJson: z.record(z.any()).optional()
});

export const HealSkippedCallbackPayloadSchema = z.object({
  runId: z.string().uuid(),
  stepIndex: z.number().int().nonnegative(),
  healSkippedReason: z.string(),
  attemptedMethod: z.string().optional()
});

export const HeartbeatCallbackPayloadSchema = z.object({
  runId: z.string().uuid(),
  workerNodeId: z.string(),
  currentStepIndex: z.number().int().nonnegative().optional(),
  timestamp: z.string().datetime().optional()
});

export const OutputsCallbackPayloadSchema = z.object({
  runId: z.string().uuid(),
  outputs: z.union([
    z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    z.array(
      z.object({
        name: z.string(),
        value: z.string().nullable(),
        dataType: z.string().optional()
      })
    )
  ])
});

export const ErrorCallbackPayloadSchema = z.object({
  runId: z.string().uuid(),
  error: z.string(),
  errorType: z.string().optional(),
  stepIndex: z.number().int().nonnegative().optional(),
  evidenceKey: z.string().optional()
});

export const CompleteCallbackPayloadSchema = z.object({
  runId: z.string().uuid(),
  status: z.enum(['PASSED', 'FAILED', 'passed', 'failed', 'CANCELLED', 'cancelled']),
  durationMs: z.number().int().nonnegative().optional(),
  healed: z.boolean().default(false),
  healCount: z.number().int().nonnegative().default(0),
  errorMessage: z.string().optional()
});

export const AutomationScheduleSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  suiteId: z.string().uuid().nullable().optional(),
  recordingId: z.string().uuid().nullable().optional(),
  environmentId: z.string().uuid().nullable().optional(),
  cronExpression: z.string().min(1),
  timezone: z.string().default('UTC'),
  parameters: z.record(z.any()).default({}),
  enabled: z.boolean().default(true),
  nextRunAt: z.string().datetime().nullable().optional(),
  lastRunAt: z.string().datetime().nullable().optional(),
  lastRunStatus: z.string().nullable().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional()
});

export const CreateAutomationScheduleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  suiteId: z.string().uuid().optional(),
  recordingId: z.string().uuid().optional(),
  environmentId: z.string().uuid().optional(),
  cronExpression: z.string().min(1),
  timezone: z.string().default('UTC'),
  parameters: z.record(z.any()).default({}),
  enabled: z.boolean().default(true)
}).refine(data => data.suiteId || data.recordingId, {
  message: 'Either suiteId or recordingId must be provided'
});

// TypeScript Types Derived from Zod
export type StepAction = z.infer<typeof StepActionSchema>;
export type StepStatus = z.infer<typeof StepStatusSchema>;
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
export type ParameterDef = z.infer<typeof ParameterDefSchema>;
export type RecordingStep = z.infer<typeof RecordingStepSchema>;
export type RecordingVersion = z.infer<typeof RecordingVersionSchema>;
export type Recording = z.infer<typeof RecordingSchema>;
export type ExecutionStepResult = z.infer<typeof ExecutionStepResultSchema>;
export type ExecutionDispatchPayload = z.infer<typeof ExecutionDispatchPayloadSchema>;
export type ExecutionResponse = z.infer<typeof ExecutionResponseSchema>;
export type RepairRecord = z.infer<typeof RepairRecordSchema>;
export type CapturedOutput = z.infer<typeof CapturedOutputSchema>;

export type WorkClaimRequest = z.infer<typeof WorkClaimRequestSchema>;
export type WorkClaimRunDetails = z.infer<typeof WorkClaimRunDetailsSchema>;
export type WorkClaimResponse = z.infer<typeof WorkClaimResponseSchema>;

export type StepCallbackPayload = z.infer<typeof StepCallbackPayloadSchema>;
export type HealCallbackPayload = z.infer<typeof HealCallbackPayloadSchema>;
export type HealSkippedCallbackPayload = z.infer<typeof HealSkippedCallbackPayloadSchema>;
export type HeartbeatCallbackPayload = z.infer<typeof HeartbeatCallbackPayloadSchema>;
export type OutputsCallbackPayload = z.infer<typeof OutputsCallbackPayloadSchema>;
export type ErrorCallbackPayload = z.infer<typeof ErrorCallbackPayloadSchema>;
export type CompleteCallbackPayload = z.infer<typeof CompleteCallbackPayloadSchema>;

export type AutomationSchedule = z.infer<typeof AutomationScheduleSchema>;
export type CreateAutomationSchedule = z.infer<typeof CreateAutomationScheduleSchema>;

