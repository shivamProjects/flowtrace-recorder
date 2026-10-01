import { describe, it, expect } from 'vitest';
import {
  RecordingEnvelopeSchema,
  SemanticStepV2Schema,
  AdapterDecisionSchema,
  SurfaceInfoSchema,
  FrameIdentitySchema,
  ExecutionRequestSchema,
  ExecutionEventSchema,
  ExecutionResultSchema,
  ReplayVerdictSchema,
} from '../protocol';

describe('@flowtrace/protocol V2 Schemas', () => {
  it('validates canonical SemanticStep V2 for all major action verbs', () => {
    const clickStep = {
      action: 'click',
      surfaceId: '550e8400-e29b-41d4-a716-446655440000',
      button: 'left',
      clickCount: 1,
      locator: {
        primary: 'button[name="save"]',
        role: 'button',
        label: 'Save Changes',
      },
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(clickStep).success).toBe(true);

    const dblClickStep = {
      action: 'dblclick',
      clickCount: 2,
      locator: { primary: 'tr.row-1' },
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(dblClickStep).success).toBe(true);

    const fillStep = {
      action: 'fill',
      value: 'John Doe',
      committedValue: 'JOHN DOE',
      locator: { primary: '#name' },
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(fillStep).success).toBe(true);

    const pressStep = {
      action: 'press',
      key: 'Enter',
      modifiers: { control: true },
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(pressStep).success).toBe(true);

    const setFilesStep = {
      action: 'setInputFiles',
      files: ['invoice.pdf'],
      value: 'invoice.pdf',
      locator: { primary: 'input[type="file"]' },
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(setFilesStep).success).toBe(true);

    const checkStep = {
      action: 'check',
      checked: true,
      locator: { primary: '#agree' },
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(checkStep).success).toBe(true);

    const uncheckStep = {
      action: 'uncheck',
      checked: false,
      locator: { primary: '#agree' },
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(uncheckStep).success).toBe(true);

    const waitStep = {
      action: 'wait',
      durationMs: 1500,
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(waitStep).success).toBe(true);
  });

  it('rejects invalid action schemas (negative contract tests)', () => {
    // 1. setInputFiles without files array
    const invalidSetFiles = {
      action: 'setInputFiles',
      files: [],
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(invalidSetFiles).success).toBe(false);

    // 2. press without key
    const invalidPress = {
      action: 'press',
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(invalidPress).success).toBe(false);

    // 3. wait with non-positive duration
    const invalidWait = {
      action: 'wait',
      durationMs: -50,
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(invalidWait).success).toBe(false);

    // 4. check with checked: false (must use uncheck)
    const invalidCheck = {
      action: 'check',
      checked: false,
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(invalidCheck).success).toBe(false);

    // 5. uncheck with checked: true (must use check)
    const invalidUncheck = {
      action: 'uncheck',
      checked: true,
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(invalidUncheck).success).toBe(false);

    // 6. Unknown action verb
    const unknownAction = {
      action: 'nonExistentVerb',
      skipInReport: false,
    };
    expect(SemanticStepV2Schema.safeParse(unknownAction).success).toBe(false);
  });

  it('validates RecordingEnvelope with provenance and capabilities', () => {
    const envelope = {
      protocolVersion: '2.0',
      recordingSessionId: '550e8400-e29b-41d4-a716-446655440000',
      recordedAt: new Date().toISOString(),
      producer: {
        kind: 'extension',
        version: '1.0.0',
        platform: 'Chrome 128',
      },
      capabilities: ['multiSurface', 'nestedFrames', 'oracleADF'],
      meta: {
        name: 'Create Invoice Test',
        sourceUrl: 'https://erp.example.com/fscmUI',
        patchId: 'oracle-fusion',
      },
      steps: [
        {
          action: 'navigate',
          value: 'https://erp.example.com/fscmUI',
          skipInReport: false,
        },
        {
          action: 'selectOption',
          value: 'Standard',
          locator: { primary: '#invoice-type' },
          skipInReport: false,
        },
      ],
    };

    const parsed = RecordingEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid protocol version or malformed session ID in envelope', () => {
    const invalidEnvelope = {
      protocolVersion: '1.0', // V2 requires '2.0'
      recordingSessionId: 'not-a-uuid',
      recordedAt: '2026-10-01T10:00:00.000Z',
      producer: { kind: 'extension', version: '1.0.0' },
      capabilities: [],
      meta: { sourceUrl: 'https://example.com', patchId: 'generic' },
      steps: [],
    };
    expect(RecordingEnvelopeSchema.safeParse(invalidEnvelope).success).toBe(false);
  });

  it('validates discriminated AdapterDecisions', () => {
    const passDecision = { kind: 'pass' };
    const claimDecision = {
      kind: 'claim',
      candidate: {
        action: 'lovSelect',
        value: 'Item-1234',
        locator: { primary: '#oj-table-row-0' },
        skipInReport: false,
      },
    };
    const augmentDecision = {
      kind: 'augment',
      patch: {
        committedValue: 'ITEM_1234_NORMALIZED',
      },
    };
    const ignoreDecision = {
      kind: 'ignore',
      reason: 'Internal ADF ripple effect click suppressed',
    };

    expect(AdapterDecisionSchema.safeParse(passDecision).success).toBe(true);
    expect(AdapterDecisionSchema.safeParse(claimDecision).success).toBe(true);
    expect(AdapterDecisionSchema.safeParse(augmentDecision).success).toBe(true);
    expect(AdapterDecisionSchema.safeParse(ignoreDecision).success).toBe(true);
  });

  it('validates FrameIdentity and SurfaceInfo', () => {
    const frame = {
      hostFrameId: 'frame-12',
      hostDocumentId: 'doc-99',
      surfaceId: '550e8400-e29b-41d4-a716-446655440000',
      url: 'https://erp.example.com/subframe.html',
      name: 'pt1:_FOr1',
      locatorPath: [
        { selector: 'iframe#pt1:_FOr1', name: 'pt1:_FOr1' },
      ],
    };
    expect(FrameIdentitySchema.safeParse(frame).success).toBe(true);

    const surface = {
      surfaceId: '550e8400-e29b-41d4-a716-446655440000',
      hostSurfaceId: 'tab-401',
      type: 'tab',
      url: 'https://erp.example.com/main',
      title: 'Oracle ERP Main',
    };
    expect(SurfaceInfoSchema.safeParse(surface).success).toBe(true);
  });

  it('validates ExecutionRequest from App/Control-Plane to Replayer', () => {
    const validRequest = {
      jobExecutionId: 'job-exec-101',
      runId: '550e8400-e29b-41d4-a716-446655440000',
      recordingId: '660e8400-e29b-41d4-a716-446655440000',
      patchId: 'oracle-adf',
      schemaVersion: '2.0',
      parameters: {
        USERNAME: 'shivam.patel',
        AMOUNT: '1500.00',
      },
      knownErrorTypes: ['POPUP_BLOCKED', 'AUTHENTICATION_REQUIRED'],
      captureScreenshots: true,
      callbackUrl: 'http://127.0.0.1:3200/api/v1/worker/runs/550e8400-e29b-41d4-a716-446655440000/step',
      callbackToken: 'worker-token-xyz',
      timeoutMs: 60000,
      steps: [
        { action: 'navigate', value: 'https://erp.example.com' },
        { action: 'fill', value: 'shivam.patel', locator: { primary: '#user' } },
        { action: 'click', locator: { primary: '#login-btn' } },
      ],
    };

    const parsed = ExecutionRequestSchema.safeParse(validRequest);
    expect(parsed.success).toBe(true);
  });

  it('validates ExecutionEvent stream messages emitted by Replayer', () => {
    const startedEvent = {
      type: 'step-started',
      jobExecutionId: 'job-exec-101',
      runId: '550e8400-e29b-41d4-a716-446655440000',
      stepIndex: 1,
      action: 'fill',
    };
    expect(ExecutionEventSchema.safeParse(startedEvent).success).toBe(true);

    const completedEvent = {
      type: 'step-completed',
      jobExecutionId: 'job-exec-101',
      runId: '550e8400-e29b-41d4-a716-446655440000',
      stepIndex: 1,
      status: 'success',
      durationMs: 450,
      heal: { attempted: false },
    };
    expect(ExecutionEventSchema.safeParse(completedEvent).success).toBe(true);

    const healSkippedEvent = {
      type: 'heal-skipped',
      jobExecutionId: 'job-exec-101',
      runId: '550e8400-e29b-41d4-a716-446655440000',
      stepIndex: 2,
      reason: 'AI heal refused: target element not reachable',
    };
    expect(ExecutionEventSchema.safeParse(healSkippedEvent).success).toBe(true);

    const completeEvent = {
      type: 'complete',
      jobExecutionId: 'job-exec-101',
      runId: '550e8400-e29b-41d4-a716-446655440000',
      success: true,
      durationMs: 2500,
      stepCount: 3,
      results: [
        { stepIndex: 0, status: 'success', durationMs: 800, action: 'navigate' },
        { stepIndex: 1, status: 'success', durationMs: 450, action: 'fill' },
        { stepIndex: 2, status: 'success', durationMs: 300, action: 'click' },
      ],
      outputs: { INVOICE_ID: 'INV-9988' },
    };
    expect(ExecutionEventSchema.safeParse(completeEvent).success).toBe(true);
  });

  it('validates ExecutionResult terminal reporting and verdicts', () => {
    const terminalResult = {
      jobExecutionId: 'job-exec-101',
      runId: '550e8400-e29b-41d4-a716-446655440000',
      success: false,
      durationMs: 4200,
      stepCount: 2,
      results: [
        { stepIndex: 0, status: 'success', durationMs: 1200, action: 'navigate' },
        {
          stepIndex: 1,
          status: 'failed',
          durationMs: 3000,
          action: 'click',
          error: 'Element not found: button[name="submit"]',
          verdict: {
            category: 'SELECTOR_NOT_FOUND',
            message: 'Target element did not appear within 3000ms',
            recoverable: true,
          },
        },
      ],
      outputs: {},
      error: 'Element not found: button[name="submit"]',
      verdict: {
        category: 'SELECTOR_NOT_FOUND',
        message: 'Target element did not appear within 3000ms',
        recoverable: true,
      },
      artifacts: [
        { kind: 'screenshot', storageKey: 'artifacts/screenshot-step-1.png', bytes: 84200 },
        { kind: 'trace', storageKey: 'artifacts/trace.zip', bytes: 1540000 },
      ],
    };

    const parsed = ExecutionResultSchema.safeParse(terminalResult);
    expect(parsed.success).toBe(true);
  });
});
