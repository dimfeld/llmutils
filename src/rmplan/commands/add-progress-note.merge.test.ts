import { describe, test, expect } from 'bun:test';
import { computeProgressNotesUnion } from './add-progress-note.js';

describe('computeProgressNotesUnion', () => {
  test('does not resurrect pruned notes when latest was rotated', () => {
    const latest = [
      { timestamp: '2024-01-03T00:00:00.000Z', text: 'A3' },
      { timestamp: '2024-01-04T00:00:00.000Z', text: 'A4' },
      { timestamp: '2024-01-05T00:00:00.000Z', text: 'A5' },
    ];
    const staleLocalMerged = [
      { timestamp: '2024-01-01T00:00:00.000Z', text: 'A1' },
      { timestamp: '2024-01-02T00:00:00.000Z', text: 'A2' },
      { timestamp: '2024-02-01T00:00:00.000Z', text: 'NB' },
    ];
    const entry = { timestamp: '2024-02-01T00:00:00.000Z', text: 'NB' };

    const out = computeProgressNotesUnion(latest, staleLocalMerged, entry, 3);
    expect(out.map((n) => n.text)).toEqual(['A4', 'A5', 'NB']);
  });
});
