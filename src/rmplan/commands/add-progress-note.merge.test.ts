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

  test('treats notes with different sources as distinct entries', () => {
    const latest = [
      {
        timestamp: '2024-02-01T00:00:00.000Z',
        text: 'Implement core pipeline',
        source: 'implementer: Task 7',
      },
    ];
    const localMerged = [
      {
        timestamp: '2024-02-01T00:00:00.000Z',
        text: 'Implement core pipeline',
        source: 'tester: Task 7',
      },
    ];
    const entry = {
      timestamp: '2024-02-01T00:00:00.000Z',
      text: 'Implement core pipeline',
      source: 'tester: Task 7',
    };

    const out = computeProgressNotesUnion(latest, localMerged, entry, 5);
    expect(out).toHaveLength(2);
    const sources = out.map((n) => n.source);
    expect(sources).toContain('implementer: Task 7');
    expect(sources).toContain('tester: Task 7');
  });
});
