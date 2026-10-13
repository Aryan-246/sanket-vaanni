/**
 * Recognition and the no-fabrication guarantees.
 *
 * These tests exist mainly to fail if someone later adds a placeholder that
 * invents a sign or a confidence. That is the single most damaging thing that
 * could happen to this project's credibility, so it is pinned down by test.
 */
import {
  DEFAULT_PROFILE_ID,
  findProfile,
  SIGN_LANGUAGE_PROFILES,
  UnimplementedRecogniser,
} from '../src/recognition';
import { SPEECH_UNAVAILABLE_REASON, UnavailableSpeaker } from '../src/speech';
import type { RecognitionInput } from '../src/recognition';
import type { SensorSample } from '../src/sensors/types';

const sample: SensorSample = {
  side: 'right',
  timestampMs: 1,
  flex: [0.5, 0.5, 0.5, 0.5, 0.5],
  accel: { x: 0, y: 0, z: 9.81 },
  gyro: { x: 0, y: 0, z: 0 },
};

/**
 * One hand's reading, wrapped the way the recogniser now receives it.
 *
 * The wrapper is not decoration: it is what makes it impossible to hand a
 * recogniser a bare sample and have it silently treated as a two-handed input.
 */
const input: RecognitionInput = { kind: 'single', side: 'right', sample };

describe('UnimplementedRecogniser', () => {
  const profile = findProfile(DEFAULT_PROFILE_ID)!;

  it('reports itself as unavailable', () => {
    const recogniser = new UnimplementedRecogniser(profile);
    expect(recogniser.isAvailable).toBe(false);
    expect(recogniser.unavailableReason).toBeTruthy();
  });

  it('never returns a sign', () => {
    const recogniser = new UnimplementedRecogniser(profile);
    // Any number of frames, run repeatedly — it must never invent output.
    for (let i = 0; i < 50; i += 1) {
      expect(recogniser.recognise(input)).toBeNull();
    }
  });

  it('exposes no confidence value anywhere in its output', () => {
    const recogniser = new UnimplementedRecogniser(profile);
    const result = recogniser.recognise(input);
    expect(result).toBeNull();
  });
});

describe('sign language profiles', () => {
  it('declares every profile as having zero vocabulary', () => {
    SIGN_LANGUAGE_PROFILES.forEach((profile) => {
      expect(profile.vocabularySize).toBe(0);
    });
  });

  it('declares every profile as planned, not available', () => {
    SIGN_LANGUAGE_PROFILES.forEach((profile) => {
      expect(profile.status).not.toBe('available');
    });
  });

  it('gives each language a distinct id', () => {
    const ids = SIGN_LANGUAGE_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not model sign languages as variants of one dictionary', () => {
    // A shared-vocabulary field would encode the mistake this project exists
    // to avoid. Guard against it being reintroduced.
    SIGN_LANGUAGE_PROFILES.forEach((profile) => {
      expect(profile).not.toHaveProperty('sharedVocabulary');
      expect(profile).not.toHaveProperty('gestures');
      // Each profile owns a list of its own. The field exists — it has to, or
      // nothing could declare which input a sign needs — but nothing about it
      // is common to two languages.
      expect(Array.isArray(profile.vocabulary)).toBe(true);
    });

    // Distinct arrays, so editing one profile's vocabulary cannot alter
    // another's. A single shared list would make the test above pass while
    // still coupling the languages together.
    const lists = SIGN_LANGUAGE_PROFILES.map((profile) => profile.vocabulary);
    expect(new Set(lists).size).toBe(lists.length);
  });

  it('never claims a larger vocabulary than it defines', () => {
    // The two fields are different claims — signs *defined* versus signs a
    // model can actually recognise — so they may legitimately differ. What can
    // never happen is reporting more recognisable signs than exist.
    SIGN_LANGUAGE_PROFILES.forEach((profile) => {
      expect(profile.vocabularySize).toBeLessThanOrEqual(profile.vocabulary.length);
    });
  });

  it('resolves the default profile', () => {
    expect(findProfile(DEFAULT_PROFILE_ID)).toBeDefined();
  });

  it('returns undefined for an unknown profile', () => {
    expect(findProfile('klingon')).toBeUndefined();
  });
});

describe('UnavailableSpeaker', () => {
  it('reports itself as unavailable', () => {
    const speaker = new UnavailableSpeaker();
    expect(speaker.isAvailable).toBe(false);
    expect(speaker.unavailableReason).toBe(SPEECH_UNAVAILABLE_REASON);
  });

  it('rejects rather than silently succeeding', async () => {
    // Resolving would let a caller believe speech happened.
    await expect(new UnavailableSpeaker().speak('hello')).rejects.toThrow(/not available on this platform/i);
  });

  it('allows stop() so cleanup paths need no special case', async () => {
    await expect(new UnavailableSpeaker().stop()).resolves.toBeUndefined();
  });
});
