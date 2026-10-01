import { describe, expect, it } from 'vitest';
import {
  ExecutionDispatchPayloadSchema,
  WorkClaimRequestSchema,
  WorkClaimResponseSchema,
  StepCallbackPayloadSchema,
  HealCallbackPayloadSchema,
  OutputsCallbackPayloadSchema,
  CompleteCallbackPayloadSchema,
  FlowTraceError,
  validPlatformDispatchFixture,
  validWorkClaimRequestFixture,
  validWorkClaimResponseFixture,
  validStepCallbackFixture,
  validHealCallbackFixture,
  validOutputsCallbackFixture,
  validCompleteCallbackFixture
} from '../index';

describe('@flowtrace/contracts compatibility suite', () => {
  it('parses valid Platform execution dispatch payload', () => {
    const parsed = ExecutionDispatchPayloadSchema.parse(validPlatformDispatchFixture);
    expect(parsed.triggerSource).toBe('PLATFORM_CHAIN');
    expect(parsed.parameterValues.invoiceNumber).toBe('INV-2026-9994');
  });

  it('parses worker claim request and response', () => {
    const req = WorkClaimRequestSchema.parse(validWorkClaimRequestFixture);
    expect(req.workerNodeId).toBe('worker-node-eu-west-1a-04');

    const res = WorkClaimResponseSchema.parse(validWorkClaimResponseFixture);
    expect(res.claimed).toBe(true);
    expect(res.run?.rawSteps).toHaveLength(2);
  });

  it('validates worker step and heal callback schemas', () => {
    const step = StepCallbackPayloadSchema.parse(validStepCallbackFixture);
    expect(step.status).toBe('PASSED');

    const heal = HealCallbackPayloadSchema.parse(validHealCallbackFixture);
    expect(heal.healApplied).toBe(true);
    expect(heal.healConfidence).toBe('0.940');
  });

  it('validates outputs and complete callback schemas', () => {
    const outputs = OutputsCallbackPayloadSchema.parse(validOutputsCallbackFixture);
    expect(outputs.runId).toBe(validOutputsCallbackFixture.runId);

    const complete = CompleteCallbackPayloadSchema.parse(validCompleteCallbackFixture);
    expect(complete.status).toBe('PASSED');
    expect(complete.healed).toBe(true);
    expect(complete.healCount).toBe(1);
  });

  it('formats FlowTraceError properly into JSON error payload', () => {
    const error = new FlowTraceError('CLAIM_CONFLICT', 'Run was already claimed by another worker', 409, {
      conflictingWorkerId: 'worker-node-b'
    });
    expect(error.code).toBe('CLAIM_CONFLICT');
    expect(error.statusCode).toBe(409);
    const json = error.toJSON();
    expect(json.code).toBe('CLAIM_CONFLICT');
    expect(json.details?.conflictingWorkerId).toBe('worker-node-b');
  });

  describe('Negative schema validation tests', () => {
    it('rejects invalid UUIDs in dispatch payload', () => {
      const invalid = {
        ...validPlatformDispatchFixture,
        recordingId: 'not-a-uuid'
      };
      expect(() => ExecutionDispatchPayloadSchema.parse(invalid)).toThrow();

      const invalidEnv = {
        ...validPlatformDispatchFixture,
        environmentId: 'bad-env-uuid'
      };
      expect(() => ExecutionDispatchPayloadSchema.parse(invalidEnv)).toThrow();
    });

    it('rejects invalid enum values in triggerSource and callback status', () => {
      const invalidTrigger = {
        ...validPlatformDispatchFixture,
        triggerSource: 'UNKNOWN_TRIGGER'
      };
      expect(() => ExecutionDispatchPayloadSchema.parse(invalidTrigger)).toThrow();

      const invalidStepStatus = {
        ...validStepCallbackFixture,
        status: 'NON_EXISTENT_STATUS'
      };
      expect(() => StepCallbackPayloadSchema.parse(invalidStepStatus)).toThrow();

      const invalidCompleteStatus = {
        ...validCompleteCallbackFixture,
        status: 'SOME_RANDOM_STATE'
      };
      expect(() => CompleteCallbackPayloadSchema.parse(invalidCompleteStatus)).toThrow();
    });

    it('rejects invalid callback URL and negative numbers', () => {
      const invalidUrl = {
        ...validPlatformDispatchFixture,
        callbackUrl: 'invalid-url-string'
      };
      expect(() => ExecutionDispatchPayloadSchema.parse(invalidUrl)).toThrow();

      const invalidWorkerClaim = {
        ...validWorkClaimRequestFixture,
        maxConcurrent: -1
      };
      expect(() => WorkClaimRequestSchema.parse(invalidWorkerClaim)).toThrow();

      const zeroWorkerClaim = {
        ...validWorkClaimRequestFixture,
        maxConcurrent: 0
      };
      expect(() => WorkClaimRequestSchema.parse(zeroWorkerClaim)).toThrow();
    });

    it('rejects missing required fields', () => {
      const missingRunId = {
        ...validStepCallbackFixture,
        runId: undefined
      };
      expect(() => StepCallbackPayloadSchema.parse(missingRunId)).toThrow();

      const missingWorkerId = {
        ...validWorkClaimRequestFixture,
        workerNodeId: ''
      };
      expect(() => WorkClaimRequestSchema.parse(missingWorkerId)).toThrow();
    });

    it('survives JSON serialization roundtrip without loss of precision or schema integrity', () => {
      const serialized = JSON.stringify(validPlatformDispatchFixture);
      const deserialized = JSON.parse(serialized);
      const parsed = ExecutionDispatchPayloadSchema.parse(deserialized);
      expect(parsed).toEqual(validPlatformDispatchFixture);

      const serializedClaim = JSON.stringify(validWorkClaimResponseFixture);
      const deserializedClaim = JSON.parse(serializedClaim);
      const parsedClaim = WorkClaimResponseSchema.parse(deserializedClaim);
      expect(parsedClaim).toEqual(validWorkClaimResponseFixture);
    });
  });
});

