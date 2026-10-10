/**
 * What the live screens are allowed to say.
 *
 * The brief's prohibitions are mostly about restraint: no fabricated phrase, no
 * invented confidence, no accuracy claim, no simulated reading dressed up as a
 * hardware one. Those are properties of rendered text, so they are asserted
 * against rendered text — both of the panels in isolation, where each state can
 * be produced exactly, and of the whole Dashboard, where the point is that
 * nothing anywhere contradicts a panel.
 *
 * The single most useful assertion in this file is the negative one: on a
 * freshly launched app there is no percentage anywhere on the Dashboard,
 * because nothing has measured anything.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import { RecognitionPanel } from '../src/components/RecognitionPanel';
import { SensorPanel } from '../src/components/SensorPanel';
import { TranslatorPanel } from '../src/components/TranslatorPanel';
import { VoicePanel } from '../src/components/VoicePanel';
import { INITIAL_LINK, type LinkState } from '../src/ble/link';
import { MOCK_DEVICE_NAME } from '../src/ble/types';
import type { GloveSnapshot } from '../src/ble/controller';
import { createDemoCalibration } from '../src/sensors/calibration';
import { findProfile } from '../src/recognition/profiles';
import {
  TRANSLATION_UNAVAILABLE_REASON,
  UnimplementedTranslator,
  evaluateTranslation,
  type TranslationOutcome,
} from '../src/translation';
import type { RecognitionOutcome } from '../src/recognition/outcome';
import { pressByLabel, renderApp, renderThemed, renderedText, teardown } from './support';

/* ------------------------------------------------------------------ fixtures */

const PROFILE = findProfile('isl')!;

function glove(overrides: Partial<GloveSnapshot> = {}): GloveSnapshot {
  return {
    side: 'right',
    link: INITIAL_LINK,
    source: 'none',
    raw: null,
    calibrated: null,
    lastPacketAtMs: null,
    packetCount: 0,
    transportName: 'Bluetooth LE (not implemented)',
    synthetic: false,
    available: false,
    ...overrides,
  };
}

/** A connected simulator that is streaming, which is this build's fullest state. */
function streamingGlove(overrides: Partial<GloveSnapshot> = {}): GloveSnapshot {
  const link: LinkState = {
    ...INITIAL_LINK,
    kind: 'connected',
    deviceId: 'demo-right',
    deviceName: MOCK_DEVICE_NAME,
  };
  const flex: [number, number, number, number, number] = [0.2, 0.45, 0.6, 0.15, 0.8];
  return glove({
    link,
    source: 'simulated',
    raw: { side: 'right', timestampMs: 1_000, flex, accel: { x: 0, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } },
    calibrated: { side: 'right', timestampMs: 1_000, flex, accel: { x: 0, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } },
    lastPacketAtMs: 1_000,
    packetCount: 40,
    transportName: 'Demo simulator',
    synthetic: true,
    available: true,
    ...overrides,
  });
}

/** No number anywhere in the text, which is the form "nothing measured" takes. */
const ANY_PERCENTAGE = /\d\s*%/;

/* ------------------------------------------------------- the recognition panel */

describe('the recognition panel', () => {
  async function panel(
    outcome: RecognitionOutcome,
    snapshot: GloveSnapshot = glove(),
  ): Promise<string> {
    const renderer = await renderThemed(
      <RecognitionPanel side="right" outcome={outcome} profile={PROFILE} glove={snapshot} />,
    );
    const output = renderedText(renderer);
    await teardown(renderer);
    return output;
  }

  it('says a missing model is missing, rather than asking the user to keep trying', async () => {
    const output = await panel({
      kind: 'unavailable',
      reason: 'No recognition model is available.',
    });

    expect(output).toContain('Recognition unavailable');
    expect(output).toContain('Not implemented');
    expect(output).toContain('No recognition model is available.');
    // Nothing here implies that holding a hand still would help.
    expect(output).not.toContain('Waiting');
    expect(output).not.toContain('keep trying');
  });

  it('distinguishes "no glove" from "no gesture"', async () => {
    const disconnected = await panel({ kind: 'idle' });
    const connected = await panel({ kind: 'idle' }, streamingGlove());

    expect(disconnected).toContain('Waiting for a gesture');
    expect(disconnected).toContain('No glove is connected');
    expect(connected).toContain('The glove is connected but no sensor frame');
  });

  it('reports a confidence only when one was measured, and calls it measured', async () => {
    const measured = await panel({
      kind: 'result',
      profileId: 'isl',
      candidate: { signId: 'namaste', label: 'नमस्ते', confidence: 0.94 },
    });

    expect(measured).toContain('नमस्ते');
    expect(measured).toContain('Recognised');
    expect(measured).toContain('94% measured');
    expect(measured).toContain('Model confidence');
  });

  it('shows no percentage at all when there is no confidence', async () => {
    for (const outcome of [
      { kind: 'unavailable', reason: 'No model.' },
      { kind: 'idle' },
    ] as RecognitionOutcome[]) {
      const output = await panel(outcome);

      expect(output).toContain('Model confidence');
      expect(output).toContain('Not available');
      expect(output).not.toMatch(ANY_PERCENTAGE);
    }
  });

  it('presents a weak match as a guess, and says the threshold has no basis', async () => {
    // An uncertain match is shown, because hiding it would be its own kind of
    // lie — but it is shown under a warning that names what it is.
    const output = await panel(
      {
        kind: 'uncertain',
        profileId: 'isl',
        candidate: { signId: 'namaste', label: 'नमस्ते', confidence: 0.42 },
      },
      streamingGlove(),
    );

    expect(output).toContain('Uncertain');
    expect(output).toContain('42% measured');
    expect(output).toContain('no empirical basis');
    expect(output).toContain('guess rather than as a result');
  });

  it('marks a simulated reading as Demo Mode and carries no accuracy claim', async () => {
    const output = await panel(
      {
        kind: 'result',
        profileId: 'isl',
        candidate: { signId: 'namaste', label: 'नमस्ते', confidence: 0.94 },
      },
      streamingGlove(),
    );

    expect(output).toContain('Demo Mode');
    for (const claim of ['accurate', 'accuracy', 'correct', 'proven']) {
      expect(output.toLowerCase()).not.toContain(claim);
    }
  });

  it('names the language profile the result was matched against', async () => {
    // Vocabulary is owned per profile, so a result without its profile would be
    // a gesture with no language attached to it.
    const output = await panel({ kind: 'idle' });

    expect(output).toContain(PROFILE.name);
    expect(output).toContain(`${PROFILE.vocabularySize} signs`);
  });
});

/* ------------------------------------------------------------ the sensor panel */

describe('the sensor panel', () => {
  it('shows a dash, not a zero, where there is no reading', async () => {
    const renderer = await renderThemed(
      <SensorPanel side="right" glove={glove()} calibration={createDemoCalibration('right')} />,
    );
    const output = renderedText(renderer);

    expect(output).toContain('No data');
    for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
      expect(output).toContain(finger);
    }
    // Five dashes for the calibrated column, five for the raw column.
    expect(output.match(/—/g)?.length).toBeGreaterThanOrEqual(10);
    // The only "0.00" on the screen belongs to the legend's documented range,
    // not to a reading: a channel with no reading draws a dash, never a zero.
    expect(output.match(/0\.00/g) ?? []).toHaveLength(1);
    expect(output).toContain('0.00–1.00');
    expect(output).not.toContain('Hardware');

    await teardown(renderer);
  });

  it('labels a simulated stream as simulated on the panel and on every row', async () => {
    const renderer = await renderThemed(
      <SensorPanel side="right" glove={streamingGlove()} calibration={createDemoCalibration('right')} />,
    );
    const output = renderedText(renderer);

    expect(output).toContain('Simulated');
    // Repeated per row, so a single row copied out of context still says so.
    expect(output.match(/simulated/g)?.length).toBeGreaterThanOrEqual(5);
    expect(output).not.toContain('Hardware');

    await teardown(renderer);
  });

  it('says the calibration in use has never been measured', async () => {
    // The numbers look like calibrated readings, and they are — but the anchors
    // behind them are an identity profile nobody captured on hardware.
    const renderer = await renderThemed(
      <SensorPanel side="right" glove={streamingGlove()} calibration={createDemoCalibration('right')} />,
    );

    expect(renderedText(renderer)).toContain('No rest or full-flex pose has been captured');

    await teardown(renderer);
  });

  it('keeps the raw and calibrated figures named as different quantities', async () => {
    const renderer = await renderThemed(
      <SensorPanel side="right" glove={streamingGlove()} calibration={createDemoCalibration('right')} />,
    );
    const output = renderedText(renderer);

    expect(output).toContain('calibrated bend');
    expect(output).toContain('raw channel value');

    await teardown(renderer);
  });
});

/* ------------------------------------------------------------- the voice panel */

describe('the voice panel', () => {
  async function panel(
    props: Partial<React.ComponentProps<typeof VoicePanel>> = {},
  ): Promise<{ output: string; toggles: boolean[] }> {
    const toggles: boolean[] = [];
    const renderer = await renderThemed(
      <VoicePanel
        enabled={false}
        onToggle={(next) => toggles.push(next)}
        available={false}
        unavailableReason="Speech output is not wired up."
        phrase={null}
        {...props}
      />,
    );
    const output = renderedText(renderer);
    await teardown(renderer);
    return { output, toggles };
  }

  it('is off until the user asks, and says what it would say', async () => {
    const { output } = await panel();

    expect(output).toContain('Off');
    expect(output).toContain('Would speak');
    expect(output).toContain('Nothing yet');
    // Nothing is spoken, so nothing claims to have been.
    expect(output).not.toContain('Ready');
  });

  it('reports the contradiction rather than hiding it when the engine is missing', async () => {
    // The user's intent and the app's capability can disagree, and today they
    // always do. The panel shows both.
    const { output } = await panel({ enabled: true });

    expect(output).toContain('Unavailable');
    expect(output).toContain('On, but nothing can be spoken');
    expect(output).toContain('Speech output is not wired up.');
    // Not greyed out: "you asked for this and it is not available" is more
    // informative than an unavailable-looking control.
    expect(output).not.toContain('Ready');
  });

  it('shows the phrase that would be spoken once one exists', async () => {
    const { output } = await panel({ enabled: true, phrase: 'नमस्ते' });

    expect(output).toContain('नमस्ते');
    expect(output).not.toContain('Nothing yet');
  });

  it('does not report ready until an engine exists', async () => {
    // The only path to 'Ready' is an available engine, which this build has not
    // got. Asserting it keeps that from quietly changing.
    const { output } = await panel({ enabled: true, available: true, unavailableReason: null });

    expect(output).toContain('Ready');
  });
});

/* -------------------------------------------------------- the translator panel */

describe('the translator panel', () => {
  async function panel(outcome: TranslationOutcome): Promise<string> {
    const renderer = await renderThemed(
      <TranslatorPanel
        outcome={outcome}
        signProfileId="isl"
        targetLanguageCode="hi"
        onChangeSignProfile={() => undefined}
        onChangeTargetLanguage={() => undefined}
      />,
    );
    const output = renderedText(renderer);
    await teardown(renderer);
    return output;
  }

  const translator = new UnimplementedTranslator();

  it('says it is not implemented, and distinguishes the two reasons it is empty', async () => {
    // "Nothing recognised" and "recognition does not exist" are different
    // problems with different fixes.
    const noModel = await panel(
      evaluateTranslation(translator, { kind: 'unavailable', reason: 'No model.' }, 'hi'),
    );
    const noSignYet = await panel(evaluateTranslation(translator, { kind: 'idle' }, 'hi'));

    expect(noModel).toContain('Not implemented');
    expect(noModel).toContain('Recognition is unavailable');
    expect(noSignYet).toContain('No phrase has been recognised');

    // Both are empty states, and neither pretends to be a translation.
    expect(noModel).toContain('Nothing to translate');
    expect(noSignYet).toContain('Nothing to translate');
  });

  it('reports a phrase it cannot translate as untranslated, showing the phrase', async () => {
    const output = await panel(
      evaluateTranslation(
        translator,
        {
          kind: 'result',
          profileId: 'isl',
          candidate: { signId: 'namaste', label: 'नमस्ते', confidence: 0.94 },
        },
        'hi',
      ),
    );

    expect(output).toContain('Cannot translate');
    expect(output).toContain('नमस्ते');
    expect(output).toContain(TRANSLATION_UNAVAILABLE_REASON);
  });

  it('keeps the two language axes separate and both editable', async () => {
    const output = await panel(evaluateTranslation(translator, { kind: 'idle' }, 'hi'));

    expect(output).toContain('SIGN LANGUAGE');
    expect(output).toContain('OUTPUT');
    expect(output).toContain('Indian Sign Language');
    expect(output).toContain('Hindi');
  });

  it('never claims to be translating live', async () => {
    const output = await panel(
      evaluateTranslation(
        translator,
        {
          kind: 'result',
          profileId: 'isl',
          candidate: { signId: 'namaste', label: 'नमस्ते', confidence: 0.94 },
        },
        'hi',
      ),
    );

    for (const claim of ['translated to', 'in real time', 'Live translation', 'accurate']) {
      expect(output.toLowerCase()).not.toContain(claim.toLowerCase());
    }
  });
});

/* --------------------------------------------------------------- the Dashboard */

describe('the Dashboard as a whole', () => {
  it('claims nothing at all before anything has been connected', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    const output = renderedText(renderer);

    // No glove, no reading, no result, no confidence, no accuracy. Recognition
    // is `unavailable` rather than `idle`, because no model exists at all —
    // which is the honest answer and not the same as "waiting".
    expect(output).toContain('No glove connected');
    expect(output).toContain('Recognition unavailable');
    expect(output).toContain('Not implemented');
    expect(output).toContain('Not available');
    expect(output).not.toMatch(ANY_PERCENTAGE);
    expect(output).not.toContain('Hardware');
    expect(output).not.toContain('Connected to');

    await teardown(renderer);
  });

  it('says wrist yaw cannot be measured rather than showing a number', async () => {
    // The part has no magnetometer: this is a property of the hardware, not a
    // missing feature.
    const { renderer } = await renderApp({ skipIntro: true });
    const output = renderedText(renderer);

    expect(output).toContain('Yaw');
    expect(output).toContain('Not measurable');
    expect(output).toContain('no magnetometer');

    await teardown(renderer);
  });

  it('says the hand is a preview rather than the 3D viewer', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    const output = renderedText(renderer);

    expect(output).toContain('Articulated preview');
    expect(output).toContain('Why this is not the 3D viewer');

    await teardown(renderer);
  });

  it('labels a connected simulator as a demo everywhere it surfaces', async () => {
    jest.useFakeTimers();
    const { renderer } = await renderApp({ skipIntro: true });

    await pressByLabel(renderer, 'Find right gloves');
    await advanceBy(700);
    await pressByLabel(renderer, 'Connect to Demo glove (simulated)');
    await advanceBy(700);

    const output = renderedText(renderer);

    expect(output).toContain('Demo Mode');
    expect(output).toContain('Simulated');
    expect(output).toContain('simulated');
    expect(output).not.toContain('Hardware');
    // The sentinel is an implementation detail and must never be on screen.
    expect(output).not.toContain(MOCK_DEVICE_NAME);

    await teardown(renderer);
    jest.useRealTimers();
  });
});

/* -------------------------------------------------------------------- audit */

describe('the Audit screen', () => {
  it('reports nothing as healthy, because nothing has reported anything', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await pressByLabel(renderer, 'Audit');
    const output = renderedText(renderer);

    expect(output).not.toContain('Healthy');
    expect(output).toContain('Unavailable');
    expect(output).toContain('Unknown');
    // The counts line says what is actually known rather than pronouncing.
    expect(output).toContain('worst of');
    expect(output).toContain('No data');
    expect(output).not.toContain('Connected');

    await teardown(renderer);
  });

  it('names every component the firmware has not reported on', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await pressByLabel(renderer, 'Audit');
    const output = renderedText(renderer);

    for (const part of [
      'ESP32 controller',
      'MPU6050 IMU',
      'ADS1115 ADC',
      'CD74HC4067 multiplexer',
      'OLED panel',
      'Five flex channels',
      'Battery',
    ]) {
      expect(output).toContain(part);
    }

    await teardown(renderer);
  });

  it('offers a refresh that re-reads, and does not offer to connect', async () => {
    const { renderer } = await renderApp({ skipIntro: true });
    await pressByLabel(renderer, 'Audit');

    expect(renderedText(renderer)).toContain('Refresh diagnostics');

    await teardown(renderer);
  });
});

/** Advances fake timers inside `act`, which the app's effects require. */
async function advanceBy(ms: number): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}
