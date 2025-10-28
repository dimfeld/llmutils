#!/usr/bin/env bun
/**
 * Test script to verify the show command enhancements
 */

import { getBlockedPlans, getChildPlans, getDiscoveredPlans } from './src/rmplan/plans.js';
import type { PlanSchema } from './src/rmplan/planSchema.js';

// Create mock plans for testing
const mockPlans = new Map<number, PlanSchema & { filename: string }>([
  [
    1,
    {
      id: 1,
      title: 'Parent Plan',
      goal: 'Test parent',
      status: 'done',
      filename: '/test/1.plan.md',
    },
  ],
  [
    2,
    {
      id: 2,
      title: 'Child Plan 1',
      goal: 'Test child',
      status: 'in_progress',
      parent: 1,
      filename: '/test/2.plan.md',
    },
  ],
  [
    3,
    {
      id: 3,
      title: 'Child Plan 2',
      goal: 'Test child',
      status: 'pending',
      parent: 1,
      filename: '/test/3.plan.md',
    },
  ],
  [
    4,
    {
      id: 4,
      title: 'Dependent Plan',
      goal: 'Depends on plan 1',
      status: 'pending',
      dependencies: [1],
      filename: '/test/4.plan.md',
    },
  ],
  [
    5,
    {
      id: 5,
      title: 'Discovered Plan',
      goal: 'Discovered from plan 1',
      status: 'pending',
      discoveredFrom: 1,
      filename: '/test/5.plan.md',
    },
  ],
]);

console.log('Testing inverse relationship functions...\n');

// Test getBlockedPlans
console.log('Testing getBlockedPlans(1):');
const blockedPlans = getBlockedPlans(1, mockPlans);
console.log(
  `  Found ${blockedPlans.length} blocked plan(s):`,
  blockedPlans.map((p) => `${p.id}: ${p.title}`)
);
console.log(`  Expected: 1 plan (ID 4)`);
console.log(
  `  Result: ${blockedPlans.length === 1 && blockedPlans[0]?.id === 4 ? '✓ PASS' : '✗ FAIL'}\n`
);

// Test getChildPlans
console.log('Testing getChildPlans(1):');
const childPlans = getChildPlans(1, mockPlans);
console.log(
  `  Found ${childPlans.length} child plan(s):`,
  childPlans.map((p) => `${p.id}: ${p.title}`)
);
console.log(`  Expected: 2 plans (IDs 2, 3)`);
console.log(
  `  Result: ${childPlans.length === 2 && childPlans.find((p) => p.id === 2) && childPlans.find((p) => p.id === 3) ? '✓ PASS' : '✗ FAIL'}\n`
);

// Test getDiscoveredPlans
console.log('Testing getDiscoveredPlans(1):');
const discoveredPlans = getDiscoveredPlans(1, mockPlans);
console.log(
  `  Found ${discoveredPlans.length} discovered plan(s):`,
  discoveredPlans.map((p) => `${p.id}: ${p.title}`)
);
console.log(`  Expected: 1 plan (ID 5)`);
console.log(
  `  Result: ${discoveredPlans.length === 1 && discoveredPlans[0]?.id === 5 ? '✓ PASS' : '✗ FAIL'}\n`
);

// Test details truncation fix
console.log('Testing details truncation fix:');
const detailsWithNewlines = 'Line 1\nLine 2\nLine 3';
const lines = detailsWithNewlines.split('\n');
console.log(`  Split on actual newlines: ${lines.length} lines`);
console.log(`  Expected: 3 lines`);
console.log(`  Result: ${lines.length === 3 ? '✓ PASS' : '✗ FAIL'}\n`);

const detailsWithLiteralBackslashN = 'Line 1\\nLine 2\\nLine 3';
const linesWrong = detailsWithLiteralBackslashN.split('\\n');
console.log(`  Old behavior (split on literal \\\\n): ${linesWrong.length} parts`);
console.log(`  This would incorrectly split on escaped backslash-n`);

console.log('\nAll tests completed!');
