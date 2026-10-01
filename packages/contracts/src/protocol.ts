import { z } from 'zod';

// ============================================================================
// @flowtrace/protocol V2 — Canonical Protocol & Capability Envelope (Ratified)
// ============================================================================

export const ProtocolVersionSchema = z.literal('2.0');

export const ProducerKindSchema = z.enum(['extension', 'desktop', 'custom']);

export const ProducerProvenanceSchema = z.object({
  kind: ProducerKindSchema,
  version: z.string().min(1),
  platform: z.string().optional(),
});

export const RecorderCapabilitySchema = z.enum([
  'multiSurface',
  'nestedFrames',
  'downloads',
  'detachedFileInput',
  'evidenceScreenshots',
  'oracleADF',
  'oracleJET',
  'redwood',
]);

export const FrameLocatorSegmentSchema = z.object({
  selector: z.string(),
  name: z.string().optional(),
  url: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
});

export const FrameIdentitySchema = z.object({
  hostFrameId: z.string(),
  hostDocumentId: z.string().optional(),
  parentHostFrameId: z.string().optional(),
  surfaceId: z.string(),
  url: z.string().optional(),
  name: z.string().optional(),
  locatorPath: z.array(FrameLocatorSegmentSchema).optional(),
});

export const SurfaceInfoSchema = z.object({
  surfaceId: z.string().uuid(),
  hostSurfaceId: z.string(),
  type: z.enum(['tab', 'popup', 'window', 'webview']),
  openerSurfaceId: z.string().optional(),
  url: z.string(),
  title: z.string().optional(),
});

export const RecordedLocatorSchema = z.object({
  selector: z.string().optional(),
  primary: z.string().optional(),
  name: z.string().optional(),
  label: z.string().optional(),
  role: z.string().optional(),
  attrSelector: z.string().optional(),
  testId: z.string().optional(),
  componentId: z.string().optional(),
  candidates: z.array(z.string()).optional(),
  backupSelectors: z.array(z.string()).optional(),
});

export const StepEffectSchema = z.object({
  type: z.string(),
  targetUrl: z.string().optional(),
  surfaceId: z.string().optional(),
  timestamp: z.number().optional(),
  details: z.record(z.any()).optional(),
});

const BaseStepFields = {
  surfaceId: z.string().optional(),
  frame: z.union([
    z.string(),
    z.object({
      url: z.string().optional(),
      name: z.string().optional(),
      selector: z.string().optional(),
      path: z.array(z.string()).optional(),
    }),
  ]).optional(),
  locator: RecordedLocatorSchema.optional(),
  description: z.string().optional(),
  skipInReport: z.boolean().default(false),
  required: z.boolean().optional(),
  requiredSource: z.string().optional(),
  requiredScope: z.string().optional(),
  effects: z.array(StepEffectSchema).optional(),
  meta: z.record(z.any()).optional(),
};

export const KeyModifiersSchema = z.object({
  alt: z.boolean().optional(),
  control: z.boolean().optional(),
  meta: z.boolean().optional(),
  shift: z.boolean().optional(),
});

export const PointerPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

// Discriminated Action Step Schemas
export const NavigateStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('navigate'),
  value: z.string().min(1),
});

export const ClickStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('click'),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clickCount: z.number().int().positive().optional(),
  modifiers: KeyModifiersSchema.optional(),
  position: PointerPositionSchema.optional(),
});

export const DblClickStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('dblclick'),
  clickCount: z.number().int().positive().default(2),
  modifiers: KeyModifiersSchema.optional(),
  position: PointerPositionSchema.optional(),
});

export const FillStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('fill'),
  value: z.string().optional(),
  committedValue: z.string().optional(),
  credentialRef: z.string().optional(),
});

export const SelectOptionStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('selectOption'),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
  optionIndex: z.number().int().nonnegative().optional(),
});

export const LovSelectStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('lovSelect'),
  value: z.string().min(1),
  optionIndex: z.number().int().nonnegative().optional(),
});

export const PressStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('press'),
  key: z.string().min(1),
  modifiers: KeyModifiersSchema.optional(),
});

export const CheckStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('check'),
  checked: z.literal(true).default(true),
});

export const UncheckStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('uncheck'),
  checked: z.literal(false).default(false),
});

export const SetInputFilesStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('setInputFiles'),
  files: z.array(z.string()).min(1),
  value: z.string().optional(),
});

export const ScrollStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('scroll'),
  deltaX: z.number().optional(),
  deltaY: z.number().optional(),
});

export const HoverStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('hover'),
  position: PointerPositionSchema.optional(),
});

export const CopyStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('copy'),
  outputName: z.string().optional(),
  value: z.string().optional(),
});

export const WaitStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('wait'),
  durationMs: z.number().positive(),
});

export const AssertVisibleStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('assertVisible'),
});

export const AssertTextStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('assertText'),
  value: z.string(),
});

export const AssertValueStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('assertValue'),
  value: z.string(),
});

export const AssertCheckedStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('assertChecked'),
  checked: z.boolean(),
});

export const AssertSnapshotStepSchema = z.object({
  ...BaseStepFields,
  action: z.literal('assertSnapshot'),
  snapshot: z.string(),
});

// Canonical Action Discriminated Union
export const SemanticStepV2Schema = z.discriminatedUnion('action', [
  NavigateStepSchema,
  ClickStepSchema,
  DblClickStepSchema,
  FillStepSchema,
  SelectOptionStepSchema,
  LovSelectStepSchema,
  PressStepSchema,
  CheckStepSchema,
  UncheckStepSchema,
  SetInputFilesStepSchema,
  ScrollStepSchema,
  HoverStepSchema,
  CopyStepSchema,
  WaitStepSchema,
  AssertVisibleStepSchema,
  AssertTextStepSchema,
  AssertValueStepSchema,
  AssertCheckedStepSchema,
  AssertSnapshotStepSchema,
]);

// SemanticCandidate represents in-flight uncommitted candidate during enrichment
export const SemanticCandidateSchema = z.object({
  action: z.string(),
  surfaceId: z.string().optional(),
  frame: z.any().optional(),
  locator: RecordedLocatorSchema.optional(),
  value: z.any().optional(),
  values: z.array(z.string()).optional(),
  key: z.string().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  clickCount: z.number().int().positive().optional(),
  modifiers: KeyModifiersSchema.optional(),
  position: PointerPositionSchema.optional(),
  checked: z.boolean().optional(),
  files: z.array(z.string()).optional(),
  committedValue: z.string().optional(),
  credentialRef: z.string().optional(),
  description: z.string().optional(),
  outputName: z.string().optional(),
  skipInReport: z.boolean().default(false),
  required: z.boolean().optional(),
  requiredSource: z.string().optional(),
  requiredScope: z.string().optional(),
  effects: z.array(StepEffectSchema).optional(),
  meta: z.record(z.any()).optional(),
});

export const AdapterDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pass'),
  }),
  z.object({
    kind: z.literal('claim'),
    candidate: SemanticCandidateSchema,
  }),
  z.object({
    kind: z.literal('augment'),
    patch: SemanticCandidateSchema.partial(),
  }),
  z.object({
    kind: z.literal('ignore'),
    reason: z.string(),
  }),
]);

export const RecordingEnvelopeSchema = z.object({
  protocolVersion: ProtocolVersionSchema,
  recordingSessionId: z.string().uuid(),
  recordedAt: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}T/)),
  producer: ProducerProvenanceSchema,
  capabilities: z.array(RecorderCapabilitySchema).default([]),
  meta: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    sourceUrl: z.string().min(1),
    patchId: z.string().default('generic'),
  }),
  steps: z.array(SemanticStepV2Schema),
});

export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;
export type ProducerProvenance = z.infer<typeof ProducerProvenanceSchema>;
export type RecorderCapability = z.infer<typeof RecorderCapabilitySchema>;
export type FrameIdentity = z.infer<typeof FrameIdentitySchema>;
export type SurfaceInfo = z.infer<typeof SurfaceInfoSchema>;
export type RecordedLocator = z.infer<typeof RecordedLocatorSchema>;
export type KeyModifiers = z.infer<typeof KeyModifiersSchema>;
export type PointerPosition = z.infer<typeof PointerPositionSchema>;
export type SemanticStepV2 = z.infer<typeof SemanticStepV2Schema>;
export type SemanticCandidate = z.infer<typeof SemanticCandidateSchema>;
export type AdapterDecision = z.infer<typeof AdapterDecisionSchema>;
export type RecordingEnvelope = z.infer<typeof RecordingEnvelopeSchema>;

// ============================================================================
// Execution Protocol & Replayer Schemas (Ratified Contract)
// ============================================================================

export const ReplayErrorCategorySchema = z.enum([
  'SELECTOR_NOT_FOUND',
  'TIMEOUT',
  'NAVIGATION_FAILED',
  'ASSERTION_FAILED',
  'AUTH_REQUIRED',
  'COMMIT_REFUSAL',
  'FRAME_DETACHED',
  'SURFACE_UNAVAILABLE',
  'UNSUPPORTED_ACTION',
  'INTERNAL_ERROR',
]);

export const ReplayVerdictSchema = z.object({
  category: ReplayErrorCategorySchema,
  message: z.string(),
  recoverable: z.boolean().default(false),
  details: z.record(z.any()).optional(),
});

export const StepExecutionStatusSchema = z.enum([
  'success',
  'failed',
  'skipped',
  'warn',
]);

export const HealRecordSchema = z.object({
  attempted: z.boolean(),
  applied: z.boolean().optional(),
  skipped: z.boolean().optional(),
  reason: z.string().optional(),
  candidate: z.any().optional(),
  fixType: z.string().optional(),
});

export const StepExecutionResultSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  status: StepExecutionStatusSchema,
  durationMs: z.number().nonnegative(),
  action: z.string(),
  error: z.string().nullable().optional(),
  verdict: ReplayVerdictSchema.optional(),
  heal: HealRecordSchema.optional(),
  screenshotKey: z.string().optional(),
  extractedOutputs: z.record(z.string().nullable()).optional(),
});

export const ExecutionEnvironmentSchema = z.object({
  baseUrl: z.string().optional(),
  credentials: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).optional(),
});

export const ExecutionRequestSchema = z.object({
  jobExecutionId: z.string().min(1),
  runId: z.string().uuid().optional(),
  recordingId: z.string().uuid().optional(),
  suiteId: z.string().uuid().optional(),
  steps: z.array(z.union([SemanticStepV2Schema, z.record(z.any())])),
  patchId: z.string().default('generic'),
  schemaVersion: z.string().default('2.0'),
  parameters: z.record(z.string()).optional(),
  knownErrorTypes: z.array(z.string()).optional(),
  captureScreenshots: z.boolean().default(false),
  callbackUrl: z.string().url().optional(),
  callbackToken: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  environment: ExecutionEnvironmentSchema.optional(),
});

export const ExecutionEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('step-started'),
    jobExecutionId: z.string(),
    runId: z.string().optional(),
    stepIndex: z.number().int().nonnegative(),
    action: z.string(),
    timestamp: z.string().optional(),
  }),
  z.object({
    type: z.literal('step-completed'),
    jobExecutionId: z.string(),
    runId: z.string().optional(),
    stepIndex: z.number().int().nonnegative(),
    status: StepExecutionStatusSchema,
    durationMs: z.number().nonnegative(),
    error: z.string().nullable().optional(),
    verdict: ReplayVerdictSchema.optional(),
    heal: HealRecordSchema.optional(),
    timestamp: z.string().optional(),
  }),
  z.object({
    type: z.literal('heal-attempted'),
    jobExecutionId: z.string(),
    runId: z.string().optional(),
    stepIndex: z.number().int().nonnegative(),
    candidate: z.any().optional(),
    timestamp: z.string().optional(),
  }),
  z.object({
    type: z.literal('heal-skipped'),
    jobExecutionId: z.string(),
    runId: z.string().optional(),
    stepIndex: z.number().int().nonnegative(),
    reason: z.string(),
    candidate: z.any().optional(),
    timestamp: z.string().optional(),
  }),
  z.object({
    type: z.literal('heartbeat'),
    jobExecutionId: z.string(),
    runId: z.string().optional(),
    timestamp: z.string().optional(),
  }),
  z.object({
    type: z.literal('complete'),
    jobExecutionId: z.string(),
    runId: z.string().optional(),
    success: z.boolean(),
    durationMs: z.number().nonnegative(),
    stepCount: z.number().int().nonnegative(),
    results: z.array(StepExecutionResultSchema),
    outputs: z.record(z.string().nullable()).optional(),
    error: z.string().nullable().optional(),
    timestamp: z.string().optional(),
  }),
]);

export const ExecutionArtifactDescriptorSchema = z.object({
  kind: z.enum(['trace', 'video', 'screenshot', 'har', 'log']),
  storageKey: z.string().min(1),
  bytes: z.number().int().nonnegative().optional(),
});

export const ExecutionResultSchema = z.object({
  jobExecutionId: z.string().min(1),
  runId: z.string().uuid().optional(),
  success: z.boolean(),
  durationMs: z.number().nonnegative(),
  stepCount: z.number().int().nonnegative(),
  results: z.array(StepExecutionResultSchema),
  outputs: z.record(z.string().nullable()).default({}),
  error: z.string().nullable().optional(),
  verdict: ReplayVerdictSchema.optional(),
  artifacts: z.array(ExecutionArtifactDescriptorSchema).optional(),
});

export type ReplayErrorCategory = z.infer<typeof ReplayErrorCategorySchema>;
export type ReplayVerdict = z.infer<typeof ReplayVerdictSchema>;
export type StepExecutionStatus = z.infer<typeof StepExecutionStatusSchema>;
export type HealRecord = z.infer<typeof HealRecordSchema>;
export type StepExecutionResult = z.infer<typeof StepExecutionResultSchema>;
export type ExecutionEnvironment = z.infer<typeof ExecutionEnvironmentSchema>;
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;
export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;
export type ExecutionArtifactDescriptor = z.infer<typeof ExecutionArtifactDescriptorSchema>;
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
