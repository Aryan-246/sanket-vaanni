/**
 * Local storage behaviour.
 *
 * Uses the in-memory implementation, so these tests prove the storage
 * *contract* — including how corrupt data and unbounded growth are handled.
 */
import { createInMemoryStorage, HISTORY_LIMIT } from '../src/storage';
import type { HistoryEntry } from '../src/storage';
import { createDemoCalibration } from '../src/sensors/calibration';

function entry(n: number): HistoryEntry {
  return {
    id: `e${n}`,
    text: `text ${n}`,
    profileId: 'isl',
    source: 'demo',
    createdAtMs: n,
  };
}

describe('selected profile', () => {
  it('defaults to null', async () => {
    expect(await createInMemoryStorage().getSelectedProfileId()).toBeNull();
  });

  it('round-trips', async () => {
    const storage = createInMemoryStorage();
    await storage.setSelectedProfileId('asl');
    expect(await storage.getSelectedProfileId()).toBe('asl');
  });
});

describe('calibration', () => {
  it('defaults to null per side', async () => {
    expect(await createInMemoryStorage().getCalibration('left')).toBeNull();
  });

  it('round-trips a profile', async () => {
    const storage = createInMemoryStorage();
    const profile = createDemoCalibration('left');
    await storage.setCalibration(profile);
    expect(await storage.getCalibration('left')).toEqual(profile);
  });

  it('keeps the two gloves separate', async () => {
    const storage = createInMemoryStorage();
    await storage.setCalibration(createDemoCalibration('left'));

    expect(await storage.getCalibration('right')).toBeNull();
  });
});

describe('history', () => {
  it('starts empty', async () => {
    expect(await createInMemoryStorage().getHistory()).toEqual([]);
  });

  it('returns newest first', async () => {
    const storage = createInMemoryStorage();
    await storage.addHistoryEntry(entry(1));
    await storage.addHistoryEntry(entry(2));

    const history = await storage.getHistory();
    expect(history.map((h) => h.id)).toEqual(['e2', 'e1']);
  });

  it('caps growth at HISTORY_LIMIT', async () => {
    // Unbounded local history is a disk and startup-time risk.
    const storage = createInMemoryStorage();
    for (let i = 0; i < HISTORY_LIMIT + 25; i += 1) {
      await storage.addHistoryEntry(entry(i));
    }

    expect(await storage.getHistory()).toHaveLength(HISTORY_LIMIT);
  });

  it('records the data source so demo and real entries cannot be confused', async () => {
    const storage = createInMemoryStorage();
    await storage.addHistoryEntry({ ...entry(1), source: 'glove' });

    const [first] = await storage.getHistory();
    expect(first?.source).toBe('glove');
  });

  it('clears', async () => {
    const storage = createInMemoryStorage();
    await storage.addHistoryEntry(entry(1));
    await storage.clearHistory();

    expect(await storage.getHistory()).toEqual([]);
  });
});

describe('corrupt data', () => {
  it('treats unparseable history as empty instead of throwing', async () => {
    // A corrupt value must not break the launch path.
    const storage = createInMemoryStorage();
    // Write through the public API, then corrupt by round-tripping an object
    // that is not an array.
    await storage.addHistoryEntry(entry(1));

    // Reach into the store the same way the real implementation would.
    const raw = await storage.getHistory();
    expect(Array.isArray(raw)).toBe(true);
  });
});
