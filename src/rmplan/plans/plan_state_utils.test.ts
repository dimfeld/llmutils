import { describe, expect, test } from 'bun:test';
import {
  isPlanPending,
  isPlanInProgress,
  isPlanDone,
  isPlanCancelled,
  isPlanDeferred,
  isPlanActionable,
  isPlanComplete,
  getStatusDisplayName,
  isValidPlanStatus,
} from './plan_state_utils.js';
import type { PlanSchema } from '../planSchema.js';

describe('plan state utilities', () => {
  describe('isPlanPending', () => {
    test('returns true for pending status', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        status: 'pending',
        tasks: [],
      };
      expect(isPlanPending(plan)).toBe(true);
    });

    test('returns true when status is not set (defaults to pending)', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        tasks: [],
      };
      expect(isPlanPending(plan)).toBe(true);
    });

    test('returns false for other statuses', () => {
      const statuses = ['in_progress', 'done', 'cancelled', 'deferred'] as const;
      for (const status of statuses) {
        const plan: PlanSchema = {
          id: 1,
          goal: 'Test goal',
          status,
          tasks: [],
        };
        expect(isPlanPending(plan)).toBe(false);
      }
    });
  });

  describe('isPlanInProgress', () => {
    test('returns true for in_progress status', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        status: 'in_progress',
        tasks: [],
      };
      expect(isPlanInProgress(plan)).toBe(true);
    });

    test('returns false for other statuses', () => {
      const statuses = ['pending', 'done', 'cancelled', 'deferred'] as const;
      for (const status of statuses) {
        const plan: PlanSchema = {
          id: 1,
          goal: 'Test goal',
          status,
          tasks: [],
        };
        expect(isPlanInProgress(plan)).toBe(false);
      }
    });

    test('returns false when status is not set', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        tasks: [],
      };
      expect(isPlanInProgress(plan)).toBe(false);
    });
  });

  describe('isPlanDone', () => {
    test('returns true for done status', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        status: 'done',
        tasks: [],
      };
      expect(isPlanDone(plan)).toBe(true);
    });

    test('returns false for other statuses', () => {
      const statuses = ['pending', 'in_progress', 'cancelled', 'deferred'] as const;
      for (const status of statuses) {
        const plan: PlanSchema = {
          id: 1,
          goal: 'Test goal',
          status,
          tasks: [],
        };
        expect(isPlanDone(plan)).toBe(false);
      }
    });
  });

  describe('isPlanCancelled', () => {
    test('returns true for cancelled status', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        status: 'cancelled',
        tasks: [],
      };
      expect(isPlanCancelled(plan)).toBe(true);
    });

    test('returns false for other statuses', () => {
      const statuses = ['pending', 'in_progress', 'done', 'deferred'] as const;
      for (const status of statuses) {
        const plan: PlanSchema = {
          id: 1,
          goal: 'Test goal',
          status,
          tasks: [],
        };
        expect(isPlanCancelled(plan)).toBe(false);
      }
    });
  });

  describe('isPlanDeferred', () => {
    test('returns true for deferred status', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        status: 'deferred',
        tasks: [],
      };
      expect(isPlanDeferred(plan)).toBe(true);
    });

    test('returns false for other statuses', () => {
      const statuses = ['pending', 'in_progress', 'done', 'cancelled'] as const;
      for (const status of statuses) {
        const plan: PlanSchema = {
          id: 1,
          goal: 'Test goal',
          status,
          tasks: [],
        };
        expect(isPlanDeferred(plan)).toBe(false);
      }
    });
  });

  describe('isPlanActionable', () => {
    test('returns true for pending status', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        status: 'pending',
        tasks: [],
      };
      expect(isPlanActionable(plan)).toBe(true);
    });

    test('returns true for in_progress status', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        status: 'in_progress',
        tasks: [],
      };
      expect(isPlanActionable(plan)).toBe(true);
    });

    test('returns true when status is not set (defaults to pending)', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        tasks: [],
      };
      expect(isPlanActionable(plan)).toBe(true);
    });

    test('returns false for complete statuses', () => {
      const statuses = ['done', 'cancelled', 'deferred'] as const;
      for (const status of statuses) {
        const plan: PlanSchema = {
          id: 1,
          goal: 'Test goal',
          status,
          tasks: [],
        };
        expect(isPlanActionable(plan)).toBe(false);
      }
    });
  });

  describe('isPlanComplete', () => {
    test('returns true for done status', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        status: 'done',
        tasks: [],
      };
      expect(isPlanComplete(plan)).toBe(true);
    });

    test('returns true for cancelled status', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        status: 'cancelled',
        tasks: [],
      };
      expect(isPlanComplete(plan)).toBe(true);
    });

    test('returns true for deferred status', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        status: 'deferred',
        tasks: [],
      };
      expect(isPlanComplete(plan)).toBe(true);
    });

    test('returns false for actionable statuses', () => {
      const statuses = ['pending', 'in_progress'] as const;
      for (const status of statuses) {
        const plan: PlanSchema = {
          id: 1,
          goal: 'Test goal',
          status,
          tasks: [],
        };
        expect(isPlanComplete(plan)).toBe(false);
      }
    });

    test('returns false when status is not set (defaults to pending)', () => {
      const plan: PlanSchema = {
        id: 1,
        goal: 'Test goal',
        tasks: [],
      };
      expect(isPlanComplete(plan)).toBe(false);
    });
  });

  describe('getStatusDisplayName', () => {
    test('returns correct display names for all statuses', () => {
      expect(getStatusDisplayName('pending')).toBe('Pending');
      expect(getStatusDisplayName('in_progress')).toBe('In Progress');
      expect(getStatusDisplayName('done')).toBe('Done');
      expect(getStatusDisplayName('cancelled')).toBe('Cancelled');
      expect(getStatusDisplayName('deferred')).toBe('Deferred');
    });

    test('returns Pending for undefined status', () => {
      expect(getStatusDisplayName(undefined)).toBe('Pending');
    });
  });

  describe('isValidPlanStatus', () => {
    test('returns true for all valid statuses', () => {
      const validStatuses = ['pending', 'in_progress', 'done', 'cancelled', 'deferred'];
      for (const status of validStatuses) {
        expect(isValidPlanStatus(status)).toBe(true);
      }
    });

    test('returns false for invalid statuses', () => {
      const invalidStatuses = ['', 'completed', 'active', 'unknown', 'PENDING', 'InProgress'];
      for (const status of invalidStatuses) {
        expect(isValidPlanStatus(status)).toBe(false);
      }
    });
  });
});
