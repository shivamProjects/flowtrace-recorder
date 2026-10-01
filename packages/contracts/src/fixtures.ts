import type {
  ExecutionDispatchPayload,
  ExecutionResponse,
  StepCallbackPayload,
  HealCallbackPayload,
  OutputsCallbackPayload,
  CompleteCallbackPayload,
  WorkClaimRequest,
  WorkClaimResponse
} from './schemas';

/**
 * Canonical test fixtures validating contract compatibility between
 * FlowTrace standalone control plane and Enterprise Platform (ep_platform).
 */

export const mockWorkspaceId = 'ws-oracle-prod-001';
export const mockRecordingId = 'a1111111-1111-4111-8111-111111111111';
export const mockEnvironmentId = 'e2222222-2222-4222-8222-222222222222';
export const mockRunId = '33333333-3333-4333-8333-333333333333';
export const mockOrgId = '00000000-0000-4000-8000-000000000001';
export const mockRecordingVersionId = '44444444-4444-4444-8444-444444444444';
export const mockJobExecutionId = 'plat-job-exec-999';

export const validPlatformDispatchFixture: ExecutionDispatchPayload = {
  workspaceId: mockWorkspaceId,
  recordingId: mockRecordingId,
  versionNumber: 1,
  environmentId: mockEnvironmentId,
  parameterValues: {
    username: 'oracle_admin',
    invoiceNumber: 'INV-2026-9994',
    approvalThreshold: 50000
  },
  triggerSource: 'PLATFORM_CHAIN',
  captureScreenshots: true,
  generatePdfReport: false,
  externalCorrelationId: mockJobExecutionId,
  callbackUrl: 'https://platform.enterprise.internal/api/internal/replay/plat-job-exec-999',
  callbackToken: 'sec_tok_live_platform_callback_xyz'
};

export const validWorkClaimRequestFixture: WorkClaimRequest = {
  workerNodeId: 'worker-node-eu-west-1a-04',
  supportedEngines: ['playwright'],
  maxConcurrent: 1
};

export const validWorkClaimResponseFixture: WorkClaimResponse = {
  claimed: true,
  run: {
    runId: mockRunId,
    orgId: mockOrgId,
    recordingId: mockRecordingId,
    recordingVersionId: mockRecordingVersionId,
    environmentId: mockEnvironmentId,
    parameterValues: {
      username: 'oracle_admin',
      invoiceNumber: 'INV-2026-9994'
    },
    rawSteps: [
      {
        index: 0,
        action: 'navigate',
        selector: 'body',
        url: 'https://oracle-erp.internal/login',
        isParameterized: false
      },
      {
        index: 1,
        action: 'fill',
        selector: 'input[name="userid"]',
        value: 'oracle_admin',
        isParameterized: false
      }
    ],
    baseUrl: 'https://oracle-erp.internal',
    executionToken: 'jwt_ephemeral_worker_exec_token_abc',
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString()
  }
};

export const validStepCallbackFixture: StepCallbackPayload = {
  runId: mockRunId,
  stepIndex: 1,
  action: 'fill',
  status: 'PASSED',
  durationMs: 142,
  screenshotKey: 'artifacts/runs/33333333-3333-4333-8333-333333333333/step-1.png'
};

export const validHealCallbackFixture: HealCallbackPayload = {
  runId: mockRunId,
  stepIndex: 2,
  healApplied: true,
  healMethod: 'aria-fallback',
  healConfidence: '0.940',
  healFrom: 'button#submit-invoice-v1',
  healTo: 'button[data-testid="submit-invoice"]',
  recoveryJson: {
    strategy: 'aria-fuzzy',
    attempted: 2
  }
};

export const validOutputsCallbackFixture: OutputsCallbackPayload = {
  runId: mockRunId,
  outputs: {
    generatedInvoiceId: 'AP-INV-990142',
    taxCalculated: 1250.50,
    statusResult: 'APPROVED'
  }
};

export const validCompleteCallbackFixture: CompleteCallbackPayload = {
  runId: mockRunId,
  status: 'PASSED',
  durationMs: 4850,
  healed: true,
  healCount: 1
};
