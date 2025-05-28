const EPOCH = new Date('2025-05-01T00:00:00.000Z').getTime();

export function generatePlanId(): string {
  const timestamp = Date.now() - EPOCH;
  return Math.abs(timestamp).toString(36);
}
