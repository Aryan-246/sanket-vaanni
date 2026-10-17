/* eslint-disable no-bitwise -- the same FNV-1a hash as `dataset.ts`; see the
   comment on the `hash` function below. */
/**
 * Splitting labelled data so that an evaluation figure means something.
 *
 * ## The leak this exists to prevent
 *
 * Windows captured seconds apart from the same sitting are near-duplicates: the
 * same hand, the same lighting, the same calibration drift, the same way the
 * person happened to hold their arm. If those windows are scattered randomly
 * across train and test, the test set contains a copy of something the model has
 * already memorised, and the accuracy it reports is a measure of memorisation.
 * On a small dataset that figure can look excellent and mean nothing.
 *
 * So the unit of splitting is the **capture session**, not the sample. Every
 * window from one sitting goes to exactly one side. This is a coarser split than
 * a random one and it always produces a worse-looking number; that is the point.
 *
 * ## Why the assignment is a deterministic function of the session id
 *
 * Nothing here uses `Math.random`. Two runs over the same dataset with the same
 * seed produce the same split, so a model's evaluation can be reproduced and a
 * reviewer can check which sessions were held out. The order comes from a hash
 * of `sessionId` salted with the seed, which is stable across platforms and
 * across storage round-trips — unlike an object's key order or the order
 * AsyncStorage happened to return rows in.
 */
import type { EvaluationReport } from './types';

/** Fraction of samples to hold out. Grouped by session, so approximate. */
export interface SplitFractions {
  readonly testFraction: number;
  readonly validationFraction: number;
  readonly seed: number;
}

export const DEFAULT_FRACTIONS: SplitFractions = {
  testFraction: 0.3,
  validationFraction: 0.0,
  seed: 1,
};

export interface SplitOutcome<T> {
  readonly train: readonly T[];
  readonly validation: readonly T[];
  readonly test: readonly T[];
  /** Sessions on each side, for the report's counts. */
  readonly counts: EvaluationReport['counts'];
  /** Why the split is not ideal, in sentences. Never empty when it is not. */
  readonly caveats: readonly string[];
}

/** Anything with a session id, which is everything a sample carries. */
interface Sessioned {
  readonly sessionId: string;
}

/**
 * A stable 32-bit hash. FNV-1a, chosen because it is ten lines, has no
 * dependencies, and gives an even enough spread for grouping a few hundred
 * sessions — this is a shuffle, not a security primitive.
 */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

/**
 * Splits samples into train, validation and test, keeping every session intact.
 *
 * Sessions are walked in hashed order and handed to test first, then validation,
 * until each has roughly its fraction of the *samples*. Off by a few is normal
 * and unavoidable: sessions are not all the same size, and honouring the
 * fraction exactly would mean cutting one session in half, which is the leak
 * this function exists to prevent.
 */
export function splitBySession<T extends Sessioned>(
  samples: readonly T[],
  fractions: SplitFractions = DEFAULT_FRACTIONS,
): SplitOutcome<T> {
  const bySession = new Map<string, T[]>();
  for (const sample of samples) {
    const existing = bySession.get(sample.sessionId);
    if (existing === undefined) bySession.set(sample.sessionId, [sample]);
    else existing.push(sample);
  }

  const sessionIds = [...bySession.keys()].sort(
    (a, b) => hash(`${fractions.seed}:${a}`) - hash(`${fractions.seed}:${b}`),
  );

  const total = samples.length;
  const testTarget = Math.round(total * fractions.testFraction);
  const validationTarget = Math.round(total * fractions.validationFraction);

  const train: T[] = [];
  const validation: T[] = [];
  const test: T[] = [];
  const sessionCounts = { train: 0, validation: 0, test: 0 };

  /*
   * At least one session must remain for training — always, including when there
   * is only one session. A split that leaves the model with nothing to learn from
   * is not a split: with a single sitting, the honest outcome is to train on all
   * of it and report that nothing was held out, which `splitCaveats` below says
   * in as many words. Leaving `0` reserved here put the only session into test
   * and handed training an empty set.
   */
  const reservedForTrain = 1;

  for (const sessionId of sessionIds) {
    const group = bySession.get(sessionId)!;
    const sessionsLeftAfter = sessionIds.length - (sessionCounts.train + sessionCounts.validation + sessionCounts.test);

    const mayTakeForTest =
      test.length < testTarget && sessionsLeftAfter - 1 >= reservedForTrain;
    const mayTakeForValidation =
      !mayTakeForTest &&
      validation.length < validationTarget &&
      test.length >= testTarget &&
      sessionsLeftAfter - 1 >= reservedForTrain;

    if (mayTakeForTest) {
      test.push(...group);
      sessionCounts.test += 1;
    } else if (mayTakeForValidation) {
      validation.push(...group);
      sessionCounts.validation += 1;
    } else {
      train.push(...group);
      sessionCounts.train += 1;
    }
  }

  const counts: EvaluationReport['counts'] = {
    train: train.length,
    validation: validation.length,
    test: test.length,
    trainSessions: sessionCounts.train,
    testSessions: sessionCounts.test,
  };

  return { train, validation, test, counts, caveats: splitCaveats(counts, sessionIds.length) };
}

/** What a reader of the counts should be told. */
function splitCaveats(counts: EvaluationReport['counts'], sessionCount: number): string[] {
  const caveats: string[] = [];

  if (counts.test === 0) {
    caveats.push(
      `No session was held out, so nothing here was measured on data the model had not seen. Capture at least ${sessionCount > 1 ? 'more sessions' : 'a second session'} before trusting a figure.`,
    );
  } else if (counts.testSessions === 1) {
    caveats.push(
      'The held-out data comes from a single capture session. A different sitting could score differently.',
    );
  }

  if (counts.train === 0) {
    caveats.push('Nothing was left to train on. The split fractions are too large for this dataset.');
  }

  return caveats;
}

/**
 * Sessions that appear on more than one side of a split.
 *
 * Returns an empty array for a well-formed split. Exported because the property
 * is worth asserting directly in tests and in a stored model's review: it is the
 * one failure mode of this file that would not be visible in the numbers.
 */
export function leakedSessions<T extends Sessioned>(
  outcome: SplitOutcome<T>,
): readonly string[] {
  const inTrain = new Set(outcome.train.map((sample) => sample.sessionId));
  const leaked = new Set<string>();
  for (const sample of [...outcome.validation, ...outcome.test]) {
    if (inTrain.has(sample.sessionId)) leaked.add(sample.sessionId);
  }
  return [...leaked].sort();
}
