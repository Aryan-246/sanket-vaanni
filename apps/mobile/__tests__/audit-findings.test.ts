/**
 * Audit findings: what the diagnostics screen is allowed to claim.
 *
 * The brief's rule is that one green badge must never stand in for "everything
 * works", and that the screen must be able to tell apart cases like "connected
 * but silent", "raw data but no calibration" and "calibration done but no
 * model". Those are decisions about evidence, so they live in a pure function —
 * which is what makes them assertable here without rendering anything.
 *
 * The property asserted most often below is the strongest form of the rule:
 * a connected simulator with no frames produces **no healthy row at all**.
 */
import {
  allHealthy,
  appFindings,
  describeSummary,
  groupFindings,
  opensByDefault,
  gloveFindings,
  summarise,
  worstOf,
  type Finding,
} from '../src/audit/findings';
import { HEALTH_LABEL, worstState, type HealthState } from '../src/audit/status';
import { INITIAL_LINK, type LinkState } from '../src/ble/link';
import { MOCK_DEVICE_NAME } from '../src/ble/types';
import type { GloveSnapshot } from '../src/ble/controller';
import { createDemoCalibration } from '../src/sensors/calibration';
import { DEFAULT_PREFERENCES } from '../src/app/preferences';
import { findProfile } from '../src/recognition/profiles';
import type { RecognitionOutcome } from '../src/recognition/outcome';
import { UnimplementedTranslator } from '../src/translation';
import { UnavailableSpeaker } from '../src/speech';

/* ------------------------------------------------------------------ fixtures */

const NOW = 10_000;

function snapshot(overrides: Partial<GloveSnapshot> = {}): GloveSnapshot {
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

/** A connected, streaming simulator — the fullest state this build can reach. */
function connectedSnapshot(overrides: Partial<GloveSnapshot> = {}): GloveSnapshot {
  const link: LinkState = {
    ...INITIAL_LINK,
    kind: 'connected',
    deviceId: 'demo-right',
    deviceName: MOCK_DEVICE_NAME,
  };
  return snapshot({
    link,
    source: 'simulated',
    raw: { side: 'right', timestampMs: NOW, flex: [0.1, 0.2, 0.3, 0.4, 0.5], accel: { x: 0, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } },
    calibrated: { side: 'right', timestampMs: NOW, flex: [0.1, 0.2, 0.3, 0.4, 0.5], accel: { x: 0, y: 0, z: 9.81 }, gyro: { x: 0, y: 0, z: 0 } },
    lastPacketAtMs: NOW - 20,
    packetCount: 128,
    transportName: 'Demo simulator',
    synthetic: true,
    available: true,
    ...overrides,
  });
}

function audit(
  overrides: Partial<Parameters<typeof gloveFindings>[0]> = {},
): Finding[] {
  return gloveFindings({
    snapshot: snapshot(),
    calibration: createDemoCalibration('right'),
    nowMs: NOW,
    ...overrides,
  });
}

/**
 * The app-level rows, with recognition supplied per test.
 *
 * Recognition became an app-level row when it stopped being per-glove: there is
 * one shared outcome now, computed from whichever hands the vocabulary requires,
 * so a per-glove copy would either duplicate the sentence or attribute a
 * two-handed sign to one hand.
 */
function appAudit(
  overrides: Partial<Parameters<typeof appFindings>[0]> = {},
): Finding[] {
  return appFindings({
    profile: findProfile('isl')!,
    preferences: DEFAULT_PREFERENCES,
    translator: new UnimplementedTranslator(),
    speaker: new UnavailableSpeaker(),
    recognition: { kind: 'idle' },
    targetLanguageName: 'English',
    targetLanguageSpeechTag: 'en-IN',
    // `null` rather than `false`: these tests run without a speech engine, so
    // the honest input is "not asked", which is what `unknown` renders as. A
    // `false` here would make the fixture assert that the device has no English
    // voice, which nothing has established.
    targetLanguageVoiceInstalled: null,
    targetLanguageVoiceReason: null,
    ...overrides,
  });
}

function byKey(findings: readonly Finding[], key: string): Finding {
  const found = findings.find((finding) => finding.key === key);
  if (found === undefined) throw new Error(`No finding with key ${key}.`);
  return found;
}

/* ------------------------------------------------------------- the summary */

/**
 * A synthetic finding, for the counting cases.
 *
 * Those cases are about tallying and ranking, not about which group a row lands
 * in, so the group is defaulted here rather than repeated on every literal. The
 * grouping cases build their own findings through the real producers, where the
 * group is what is under test.
 */
function auditRow(state: HealthState, key = 'k'): Finding {
  return { key, group: 'connection', label: key, state, detail: '' };
}

describe('summarise', () => {
  it('counts by state and reports the worst', () => {
    const summary = summarise([
      auditRow('healthy', 'a'),
      auditRow('unknown', 'b'),
      auditRow('warning', 'c'),
      auditRow('warning', 'd'),
    ]);

    expect(summary.total).toBe(4);
    expect(summary.counts.warning).toBe(2);
    expect(summary.counts.healthy).toBe(1);
    expect(summary.worst).toBe('warning');
  });

  it('ranks unknown above healthy, so "no evidence" is never reassurance', () => {
    // `unknown` is not a fault, but it is not a clean bill of health either.
    const summary = summarise([auditRow('healthy', 'a'), auditRow('unknown', 'b')]);

    expect(summary.worst).toBe('unknown');
  });

  it('orders severity the same way the shared scale does', () => {
    // Two severity scales in one app is how a summary chip ends up disagreeing
    // with the rows beneath it, so this delegates rather than duplicating.
    const states: HealthState[] = ['healthy', 'unknown', 'unavailable', 'warning', 'disconnected'];

    expect(worstOf(states.map((state, index) => auditRow(state, `${index}`)))).toBe(
      worstState(states),
    );
  });

  it('has nothing to report for an empty list', () => {
    expect(describeSummary(summarise([]))).toBe('Nothing to report.');
    expect(worstOf([])).toBe('unknown');
  });

  it('only calls a list fully healthy when every row reported working', () => {
    expect(allHealthy([auditRow('healthy', 'a')])).toBe(true);
    expect(allHealthy([auditRow('healthy', 'a'), auditRow('unknown', 'b')])).toBe(false);
    // An empty list is vacuously every(), which would read as "all good".
    expect(allHealthy([])).toBe(false);
  });

  it('uses the shared state vocabulary in its counts line', () => {
    const line = describeSummary(
      summarise([auditRow('unavailable', 'a'), auditRow('healthy', 'b')]),
    );

    expect(line).toContain(HEALTH_LABEL.unavailable.toLowerCase());
    expect(line).toContain(HEALTH_LABEL.healthy.toLowerCase());
  });
});

/* ---------------------------------------------------------- one glove, honestly */

describe('gloveFindings', () => {
  it('produces no healthy row for a glove that has not reported anything', () => {
    // The strongest form of the rule. With nothing connected there is no
    // evidence for anything, and the findings say so rather than assuming.
    const findings = audit();

    expect(findings.some((finding) => finding.state === 'healthy')).toBe(false);
    expect(findings.length).toBeGreaterThan(8);
  });

  it('is very nearly all unknown or unavailable on a fresh build', () => {
    const summary = summarise(audit());

    // Only the state counts are checked, not exact numbers: the point is that
    // nothing here is being reported as working.
    expect(summary.counts.healthy).toBe(0);
    expect(summary.counts.unknown + summary.counts.unavailable + summary.counts.warning).toBe(
      summary.total,
    );
  });

  it('says a connected but silent link is a warning, not a healthy link', () => {
    const findings = audit({
      snapshot: connectedSnapshot({ lastPacketAtMs: null, packetCount: 0 }),
    });

    const packets = byKey(findings, 'right.packets');
    expect(packets.state).toBe('warning');
    expect(packets.detail).toContain('no frame has arrived');
    expect(byKey(findings, 'right.link').state).toBe('healthy');
  });

  it('calls frames healthy only while they are inside the freshness window', () => {
    const fresh = byKey(audit({ snapshot: connectedSnapshot() }), 'right.packets');
    expect(fresh.state).toBe('healthy');
    expect(fresh.source).toBe('simulated');

    const stale = byKey(
      audit({ snapshot: connectedSnapshot({ lastPacketAtMs: NOW - 4_000 }) }),
      'right.packets',
    );
    expect(stale.state).toBe('warning');
    expect(stale.detail).toContain('older than the');
  });

  it('never reports packet freshness as hardware when it is simulated', () => {
    // Simulated data can be perfectly healthy. It must not be mistaken for real.
    const packets = byKey(audit({ snapshot: connectedSnapshot() }), 'right.packets');

    expect(packets.source).toBe('simulated');
  });

  it('names which flex channels are missing rather than counting them', () => {
    const findings = audit({
      snapshot: connectedSnapshot({
        calibrated: {
          side: 'right',
          timestampMs: NOW,
          // Pinky never reported — the "one flex sensor unavailable" case.
          flex: [0.1, 0.2, 0.3, 0.4, Number.NaN],
          accel: { x: 0, y: 0, z: 9.81 },
          gyro: { x: 0, y: 0, z: 0 },
        },
      }),
    });

    const flex = byKey(findings, 'right.flex');
    expect(flex.state).toBe('warning');
    expect(flex.detail).toContain('4 of 5 reporting');
    expect(flex.detail).toContain('Pinky');
    // A channel with no reading is marked absent, never as a zero reading.
    expect(flex.detail).toContain('Pinky ·');
    expect(flex.detail).not.toContain('Pinky ✓');
  });

  it('does not treat a NaN as a reading', () => {
    const flex = byKey(
      audit({
        snapshot: connectedSnapshot({
          calibrated: {
            side: 'right',
            timestampMs: NOW,
            flex: [Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN],
            accel: { x: 0, y: 0, z: 9.81 },
            gyro: { x: 0, y: 0, z: 0 },
          },
        }),
      }),
      'right.flex',
    );

    expect(flex.state).toBe('warning');
    expect(flex.detail).toContain('0 of 5 reporting');
  });

  it('says raw data without calibration is not yet meaningful', () => {
    // The demo profile passes values through. Sounding harmless, it is still
    // not a measurement, and the calibration row must not read "healthy".
    const calibration = byKey(audit(), 'right.calibration');

    expect(calibration.state).toBe('unavailable');
    expect(calibration.detail).toContain('never been measured');
  });

  it('accepts a real capture as healthy and records what it was tied to', () => {
    const findings = audit({
      calibration: { ...createDemoCalibration('right'), capturedAtMs: 1_700_000_000_000 },
    });

    const calibration = byKey(findings, 'right.calibration');
    expect(calibration.state).toBe('healthy');
    expect(calibration.detail).toContain('not tied to a sign language');
  });

  it('reports the controller, IMU, ADC, multiplexer, panel and battery as unproven', () => {
    // None of these have reported anything, so none of them may read as working
    // and none may read as broken either.
    const findings = audit();

    for (const key of [
      'right.esp32',
      'right.mpu6050',
      'right.ads1115',
      'right.cd74hc4067',
      'right.oled',
    ]) {
      expect(byKey(findings, key).state).toBe('unknown');
    }

    const battery = byKey(findings, 'right.battery');
    expect(battery.state).toBe('unavailable');
    expect(battery.detail).toContain('invention');
  });

  it('notes that wrist yaw is unobservable on this IMU', () => {
    // Not a missing feature — the part has no magnetometer, so yaw cannot be
    // measured however much code is written.
    expect(byKey(audit(), 'right.mpu6050').detail).toContain('no magnetometer');
  });

  it('says the OLED Studio writes nothing', () => {
    expect(byKey(audit(), 'right.oled').detail).toContain('writes nothing');
  });

  it('keeps the two gloves separate', () => {
    const left = gloveFindings({
      snapshot: snapshot({ side: 'left' }),
      calibration: createDemoCalibration('left'),
      nowMs: NOW,
    });

    expect(left.every((finding) => finding.key.startsWith('left.'))).toBe(true);
    expect(byKey(left, 'left.esp32').detail).toContain('Left controller');
  });

  it('does not reorder as state changes', () => {
    // A list that reshuffles under the reader's finger is worse than an
    // unsorted one, so the order is fixed by construction.
    const quiet = audit().map((finding) => finding.key);
    const busy = audit({ snapshot: connectedSnapshot() }).map((finding) => finding.key);

    expect(busy).toEqual(quiet);
  });
});

/* --------------------------------------------------- recognition as evidence */

describe('the recognition row', () => {
  const cases: Array<{ outcome: RecognitionOutcome; state: HealthState; expect: string }> = [
    {
      outcome: { kind: 'unavailable', reason: 'No model.' },
      state: 'unavailable',
      expect: 'No model.',
    },
    { outcome: { kind: 'idle' }, state: 'unknown', expect: 'has not run' },
    { outcome: { kind: 'no-result' }, state: 'healthy', expect: 'normal outcome' },
    {
      outcome: { kind: 'blocked', blocker: 'no-gloves', reason: 'Nothing is connected.' },
      state: 'warning',
      expect: 'Nothing is connected.',
    },
  ];

  it.each(cases)('reports $state for $outcome.kind', ({ outcome, state, expect: wording }) => {
    const finding = byKey(appAudit({ recognition: outcome }), 'app.recognition');

    expect(finding.state).toBe(state);
    expect(finding.detail).toContain(wording);
  });

  it('names the blocked state as something to act on, not as a model problem', () => {
    const blocked = byKey(
      appAudit({
        recognition: { kind: 'blocked', blocker: 'no-vocabulary', reason: 'No signs defined.' },
      }),
      'app.recognition',
    );

    expect(blocked.state).not.toBe('unavailable');
    expect(blocked.detail).toContain('Not being evaluated');
  });

  it('distinguishes "ran and found nothing" from "never ran"', () => {
    // Both mean no sign on screen. Only one of them is a statement about the
    // model, and the wording has to keep them apart.
    const idle = byKey(appAudit({ recognition: { kind: 'idle' } }), 'app.recognition');
    const none = byKey(appAudit({ recognition: { kind: 'no-result' } }), 'app.recognition');

    expect(idle.state).not.toBe(none.state);
    expect(idle.detail).toContain('not a statement about the model');
  });

  it('shows a measured confidence on a result, and names the hand it came from', () => {
    const finding = byKey(
      appAudit({
        recognition: {
          kind: 'result',
          profileId: 'isl',
          candidate: { signId: 'namaste', label: 'नमस्ते', confidence: 0.93 },
          hands: ['right'],
        },
      }),
      'app.recognition',
    );

    expect(finding.state).toBe('healthy');
    expect(finding.detail).toContain('93% measured');
    expect(finding.detail).toContain('the right hand');
  });

  it('attributes a two-handed result to both hands', () => {
    const finding = byKey(
      appAudit({
        recognition: {
          kind: 'result',
          profileId: 'isl',
          candidate: { signId: 'namaste', label: 'नमस्ते', confidence: 0.93 },
          hands: ['left', 'right'],
        },
      }),
      'app.recognition',
    );

    expect(finding.detail).toContain('both hands');
  });

  it('calls an uncertain match a warning and quotes the threshold honestly', () => {
    const finding = byKey(
      appAudit({
        recognition: {
          kind: 'uncertain',
          profileId: 'isl',
          candidate: { signId: 'namaste', label: 'नमस्ते', confidence: 0.42 },
          hands: ['right'],
        },
      }),
      'app.recognition',
    );

    expect(finding.state).toBe('warning');
    expect(finding.detail).toContain('42%');
    expect(finding.detail).toContain('No result is being shown');
    expect(finding.detail).toContain('not a validated operating point');
  });
});

/* -------------------------------------------------------------- the app rows */

describe('appFindings', () => {
  const app = appAudit();

  it('does not call an empty vocabulary healthy', () => {
    // A profile with no signs cannot recognise anything, however correctly it
    // is selected.
    const profile = byKey(app, 'app.profile');
    expect(profile.state).toBe('unavailable');
    expect(profile.detail).toContain('no vocabulary defined');
  });

  it('reports translation and speech as unavailable, and the voice as unknown', () => {
    expect(byKey(app, 'app.translation').state).toBe('unavailable');
    expect(byKey(app, 'app.speech').state).toBe('unavailable');

    const language = byKey(app, 'app.speech-language');
    // The fixture passes `targetLanguageVoiceInstalled: null` — "not asked",
    // which is not the same as "no voice installed". Only a confirmed false
    // may render as unavailable; an unanswered probe is unknown.
    expect(language.state).toBe('unknown');
    expect(language.detail).toContain('has not been established yet');
  });

  it('says the Bluetooth adapter is unknown, because nothing has asked', () => {
    const bluetooth = byKey(app, 'app.bluetooth');
    expect(bluetooth.state).toBe('unknown');
    expect(bluetooth.detail).toContain('genuinely unknown');
  });

  it('records that the backend client is never called', () => {
    const network = byKey(app, 'app.network');
    expect(network.state).toBe('unavailable');
    expect(network.detail).toContain('nothing is sent anywhere today');
  });

  it('never renders a detail line that merely repeats its own state word', () => {
    // The detail is supposed to say what the state is based on. A row whose
    // detail is the label again tells the reader nothing.
    for (const finding of [...app, ...audit({ snapshot: connectedSnapshot() })]) {
      expect(finding.detail.length).toBeGreaterThan(HEALTH_LABEL[finding.state].length + 4);
      expect(finding.detail).not.toBe(HEALTH_LABEL[finding.state]);
    }
  });
});

/* ---------------------------------------------------------------- grouping */

describe('grouping the findings', () => {
  const everyGroupInput = (): Finding[] => [
    ...audit({ snapshot: connectedSnapshot() }).map((finding) => ({ ...finding, side: 'left' as const })),
    ...appAudit(),
  ];

  it('puts every finding in exactly one group', () => {
    // A row that matches no group is a row the screen never draws, which is how
    // a fault disappears from a diagnostics screen.
    const groups = groupFindings(everyGroupInput());
    const grouped = groups.flatMap((group) => group.findings);

    expect(grouped).toHaveLength(everyGroupInput().length);
    for (const finding of everyGroupInput()) {
      expect(grouped.filter((entry) => entry.key === finding.key)).toHaveLength(1);
    }
  });

  it('draws the groups in the fixed order, not sorted by severity', () => {
    // A list that reorders itself under the reader's finger is worse than one
    // that is merely unsorted.
    const keys = groupFindings(everyGroupInput()).map((group) => group.key);

    expect(keys).toEqual([
      'connection',
      'flex',
      'motion',
      'adc',
      'oled',
      'calibration',
      'recognition',
      'language',
      'services',
    ]);
  });

  it('omits a group with no findings rather than drawing it empty', () => {
    // An empty group would read as "this part reported nothing", which is a
    // claim about hardware rather than about the screen.
    const groups = groupFindings(appAudit());

    expect(groups.map((group) => group.key)).toEqual(['recognition', 'language', 'services']);
  });

  it('reports each group\u2019s worst state, delegating to the shared scale', () => {
    // Two severity scales in one app is how a heading's chip ends up disagreeing
    // with the rows beneath it.
    for (const group of groupFindings(everyGroupInput())) {
      expect(group.worst).toBe(worstState(group.findings.map((finding) => finding.state)));
    }
  });

  it('counts each group\u2019s rows by state', () => {
    const groups = groupFindings(everyGroupInput());
    const connection = groups.find((group) => group.key === 'connection');

    expect(connection?.findings).toHaveLength(3);
    expect(
      connection === undefined
        ? 0
        : connection.counts.warning +
            connection.counts.healthy +
            connection.counts.disconnected +
            connection.counts.unavailable +
            connection.counts.unknown,
    ).toBe(3);
  });

  it('keeps both hands\u2019 rows of one component together', () => {
    // The reason for grouping by component: a fault in the IMU is investigated
    // by comparing the two hands, which two per-glove blocks do not invite.
    const groups = groupFindings([
      ...audit({ snapshot: connectedSnapshot({ side: 'left' }) }),
      ...audit({ snapshot: connectedSnapshot({ side: 'right' }) }),
      ...appAudit(),
    ]);
    const motion = groups.find((group) => group.key === 'motion');

    expect(motion?.findings.map((finding) => finding.side)).toEqual(['left', 'right']);
  });

  it('opens a group that holds a fault, and leaves the rest closed', () => {
    // Opening on a warning is what keeps a real problem from hiding behind a tap
    // the user has no reason to make. `unavailable` and `unknown` are the honest
    // resting states here, and opening those would open everything.
    //
    // The fault used is "connected but silent" — a link that is up with no frame
    // ever arriving on it. A link that *is* streaming is healthy, not a warning,
    // which is why the silent snapshot is the one that matters here.
    const silent = connectedSnapshot({
      lastPacketAtMs: null,
      packetCount: 0,
      raw: null,
      calibrated: null,
    });
    const groups = groupFindings([...audit({ snapshot: silent }), ...appAudit()]);

    for (const group of groups) {
      const faulty = group.worst === 'warning' || group.worst === 'disconnected';
      expect(opensByDefault(group)).toBe(faulty);
    }

    // Concretely: the connected-but-silent glove is a warning, so it opens.
    const connection = groups.find((group) => group.key === 'connection');
    expect(connection?.worst).toBe('warning');
    expect(opensByDefault(connection!)).toBe(true);

    // Nothing reports a fault about a battery, so that group stays shut.
    const oled = groups.find((group) => group.key === 'oled');
    expect(opensByDefault(oled!)).toBe(false);
  });

  it('opens nothing when there is no fault to show', () => {
    const groups = groupFindings(appAudit());

    expect(groups.some(opensByDefault)).toBe(false);
  });
});
