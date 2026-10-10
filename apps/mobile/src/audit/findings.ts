/**
 * Audit findings.
 *
 * ## Why this is a pure function and not a component
 *
 * The brief's rule is that a single green badge must never stand in for "every
 * component is working", and that the screen must distinguish "BLE connected but
 * no recent packets" from "ESP32 reachable but one flex sensor missing" from
 * "raw data but no calibration". Those are decisions about *evidence*. Written
 * inside a component they would be untestable prose; written here they are a
 * function from a snapshot to a list, and a test can assert that a connected
 * simulator with no frames does not produce a single `healthy` row.
 *
 * ## The rule this file enforces
 *
 * A row is `healthy` only when something actually reported. Everything the
 * firmware has not been asked about — or cannot report, because it has no
 * telemetry frame — is `unknown` or `unavailable`. Neither of those is a fault,
 * and neither is ever rendered as one: `unknown` means "no evidence either way",
 * which is a different claim from "broken".
 *
 * `DataSource` is carried alongside health rather than folded into it, because
 * simulated data can be perfectly healthy and real data can be broken. A row
 * that is healthy *and* simulated must say both.
 */
import type { GloveSnapshot } from '../ble/controller';
import { PACKET_STALE_MS } from '../ble/controller';
import { deviceDisplayName, isSimulatedLink, linkHealth } from '../ble/link';
import type { DataSource, HealthState } from './status';
import { HEALTH_LABEL, worstState } from './status';
import type { GloveSide } from '../ble/types';
import type { CalibrationProfile } from '../sensors/calibration';
import type { RecognitionOutcome } from '../recognition/outcome';
import { RESULT_CONFIDENCE_THRESHOLD } from '../recognition/outcome';
import type { SignLanguageProfile } from '../recognition/profiles';
import type { Speaker } from '../speech';
import type { Translator } from '../translation';
import type { AppPreferences } from '../app/preferences';
import { FINGERS } from '../sensors/types';

/** One line of the audit. */
export interface Finding {
  /** Stable across renders; used as the list key. */
  readonly key: string;
  readonly label: string;
  readonly state: HealthState;
  /** What the state is based on. Never a restatement of the state word. */
  readonly detail: string;
  /** Present when the row is about a reading, so provenance can be shown. */
  readonly source?: DataSource;
}

export interface AuditSummary {
  /** The most attention-worthy state present, for the headline chip. */
  readonly worst: HealthState;
  /** Count per state, for the "what is actually known" line. */
  readonly counts: Readonly<Record<HealthState, number>>;
  readonly total: number;
}

/**
 * Counts by state, plus the worst state.
 *
 * The worst state is deliberately *not* turned into a single verdict word on its
 * own — on this build most components are `unknown` by construction, and one
 * word would say less than the counts do.
 */
export function summarise(findings: readonly Finding[]): AuditSummary {
  const counts: Record<HealthState, number> = {
    healthy: 0,
    warning: 0,
    disconnected: 0,
    unavailable: 0,
    unknown: 0,
  };
  for (const finding of findings) counts[finding.state] += 1;

  return { worst: worstOf(findings), counts, total: findings.length };
}

/**
 * Worst state by severity.
 *
 * Delegates to `worstState` rather than carrying its own ordering: two severity
 * scales in one app is exactly the kind of drift that ends with the summary chip
 * disagreeing with the rows beneath it.
 */
export function worstOf(findings: readonly Finding[]): HealthState {
  return worstState(findings.map((finding) => finding.state));
}

/** True when every row is known to be working. The only case worth a plain "OK". */
export function allHealthy(findings: readonly Finding[]): boolean {
  return findings.length > 0 && findings.every((finding) => finding.state === 'healthy');
}

/* ------------------------------------------------------------------- gloves */

export interface GloveAuditInput {
  readonly snapshot: GloveSnapshot;
  readonly calibration: CalibrationProfile;
  readonly outcome: RecognitionOutcome;
  readonly nowMs: number;
}

/**
 * Findings for one glove.
 *
 * Order is fixed — link first, then data, then the components the firmware has
 * not reported on — so the screen does not reshuffle as state changes. Rows are
 * not sorted by severity on purpose: a list that reorders itself under the
 * reader's finger is worse than one that is merely unsorted.
 */
export function gloveFindings(input: GloveAuditInput): Finding[] {
  const { snapshot, calibration, outcome, nowMs } = input;
  const side = snapshot.side;
  const hand = side === 'left' ? 'Left' : 'Right';
  const { link } = snapshot;

  const findings: Finding[] = [];

  /* 1 — the link itself. */
  findings.push({
    key: `${side}.link`,
    label: 'BLE link',
    state: linkHealth(link),
    detail:
      link.kind === 'connected'
        ? `${isSimulatedLink(link) ? 'Connected to the simulator' : 'Connected to hardware'}${
            link.deviceName !== null ? ` — ${deviceDisplayName(link.deviceName)}` : ''
          }.`
        : (link.reason ??
          `Nothing is linked. The last scan ${link.lastScanAtMs === null ? 'has not run' : 'found nothing to keep'}.`),
  });

  /*
   * 2 — whether frames are actually arriving.
   *
   * This is the row that catches "connected but silent", which is the case a
   * link-only badge would hide. It is `warning` rather than `healthy` when the
   * link is up and the last packet is old, and `unknown` — not `warning` — when
   * nothing has ever arrived on a link that is not up, because there is nothing
   * to be stale.
   */
  if (snapshot.lastPacketAtMs === null) {
    findings.push({
      key: `${side}.packets`,
      label: 'Sensor packets',
      state: link.kind === 'connected' ? 'warning' : 'unknown',
      detail:
        link.kind === 'connected'
          ? 'The link is up but no frame has arrived on it yet. Nothing on this screen is measured data.'
          : 'No frame has arrived. This glove has not produced data in this session.',
      source: 'none',
    });
  } else {
    const ageMs = Math.max(0, nowMs - snapshot.lastPacketAtMs);
    const fresh = ageMs <= PACKET_STALE_MS;
    findings.push({
      key: `${side}.packets`,
      label: 'Sensor packets',
      state: fresh ? 'healthy' : 'warning',
      detail: `${snapshot.packetCount} frame${snapshot.packetCount === 1 ? '' : 's'} this session, last ${
        ageMs < 1000 ? `${Math.round(ageMs)} ms` : `${(ageMs / 1000).toFixed(1)} s`
      } ago${fresh ? '' : ` — older than the ${PACKET_STALE_MS} ms freshness window`}.`,
      source: snapshot.source,
    });
  }

  /* 3 — the controller. Never reported by any firmware, so never healthy. */
  findings.push({
    key: `${side}.esp32`,
    label: 'ESP32 controller',
    state: link.kind === 'unavailable' ? 'unavailable' : 'unknown',
    detail:
      link.kind === 'unavailable'
        ? 'Unreachable: no transport is available to reach it with.'
        : `${hand} controller. The firmware reports no device identity, firmware version or uptime, so its state is not something this app can know.`,
  });

  /* 4 — the five flex channels, named individually. */
  findings.push(flexFinding(side, snapshot));

  /* 5 — calibration. Absence here changes how every flex number should be read. */
  const demoCalibration = calibration.capturedAtMs === 0;
  findings.push({
    key: `${side}.calibration`,
    label: 'Calibration',
    state: demoCalibration ? 'unavailable' : 'healthy',
    detail: demoCalibration
      ? 'No anchors have been captured for this glove. Readings pass through an identity profile (rest 0, full flex 1) that has never been measured, so calibrated values are not yet meaningful.'
      : `Anchors captured ${new Date(calibration.capturedAtMs).toLocaleString()}${
          calibration.signLanguageId === null
            ? '; not tied to a sign language.'
            : `; captured for profile ${calibration.signLanguageId}.`
        }`,
  });

  /* 6 — the IMU. */
  findings.push({
    key: `${side}.mpu6050`,
    label: 'MPU6050 IMU',
    state: 'unknown',
    detail:
      'The firmware has not reported an IMU. Accelerometer and gyroscope values appear in the frame, but nothing identifies the part, and its bias and scale are uncorrected. Wrist yaw is not observable on this part at all — it has no magnetometer.',
  });

  /* 7, 8 — the ADC and the multiplexer. */
  findings.push({
    key: `${side}.ads1115`,
    label: 'ADS1115 ADC',
    state: 'unknown',
    detail:
      'No telemetry identifies an external ADC, and no raw channel counts have been observed — so which converter digitises the flex channels is not established.',
  });

  findings.push({
    key: `${side}.cd74hc4067`,
    label: 'CD74HC4067 multiplexer',
    state: 'unknown',
    detail:
      'No telemetry reports a multiplexer, its channel map or its selected input. Which physical channel each finger is wired to is unverified.',
  });

  /* 9 — the panel. */
  findings.push({
    key: `${side}.oled`,
    label: 'OLED panel',
    state: 'unknown',
    detail:
      'The firmware has not reported whether a panel is attached, what it is currently showing, or that it accepted a frame. The OLED Studio preview is a design surface and writes nothing.',
  });

  /* 10 — the pack. */
  findings.push({
    key: `${side}.battery`,
    label: 'Battery',
    state: 'unavailable',
    detail:
      'No telemetry frame carries a battery reading, and no command to read one has been verified. A percentage here would be an invention.',
  });

  /* 11 — recognition, for this glove's current sample. */
  findings.push(recognitionFinding(side, outcome));

  return findings;
}

/**
 * The five channels, each named.
 *
 * This is the row the brief asks to be able to say "ESP32 reachable but one flex
 * sensor unavailable" with. It therefore reports *which* channels are missing
 * rather than a count, and it reports `.` for a channel with no reading instead
 * of `0` — a flat finger and an absent sensor must not look the same.
 */
function flexFinding(side: GloveSide, snapshot: GloveSnapshot): Finding {
  const values = snapshot.calibrated?.flex ?? null;
  const present = values === null ? FINGERS.map(() => false) : values.map(isFiniteReading);
  const missing = FINGERS.filter((_finger, index) => !present[index]);
  const count = present.filter(Boolean).length;

  const listed = FINGERS.map(
    (finger, index) => `${capitalise(finger)} ${present[index] ? '✓' : '·'}`,
  ).join('  ·  ');

  if (values === null) {
    return {
      key: `${side}.flex`,
      label: 'Five flex channels',
      state: 'unknown',
      detail: `No reading from any channel. ${listed}.`,
      source: 'none',
    };
  }

  return {
    key: `${side}.flex`,
    label: 'Five flex channels',
    state: count === 5 ? 'healthy' : 'warning',
    detail:
      count === 5
        ? `All five channels reporting. ${listed}.`
        : `${count} of 5 reporting; no reading from ${missing
            .map(capitalise)
            .join(', ')}. ${listed}.`,
    source: snapshot.source,
  };
}

/**
 * Whether a flex channel produced a real number.
 *
 * A `NaN` or an infinity is not a reading, and treating one as present would put
 * a working-looking row over a channel that has never reported.
 */
function isFiniteReading(value: number): boolean {
  return Number.isFinite(value);
}

function recognitionFinding(side: GloveSide, outcome: RecognitionOutcome): Finding {
  switch (outcome.kind) {
    case 'unavailable':
      return {
        key: `${side}.recognition`,
        label: 'Recognition',
        state: 'unavailable',
        detail: outcome.reason,
      };
    case 'result':
      return {
        key: `${side}.recognition`,
        label: 'Recognition',
        state: 'healthy',
        detail: `“${outcome.candidate.label}” at ${Math.round(
          outcome.candidate.confidence * 100,
        )}% measured confidence.`,
      };
    case 'uncertain':
      /*
       * The recogniser is present but refused to commit. That is the model
       * working as designed, so it is not a fault — but it is not a result
       * either, and the wording must not let the two be confused.
       */
      return {
        key: `${side}.recognition`,
        label: 'Recognition',
        state: 'warning',
        detail: `A candidate scored ${Math.round(
          outcome.candidate.confidence * 100,
        )}%, below the ${Math.round(
          RESULT_CONFIDENCE_THRESHOLD * 100,
        )}% threshold it must clear to be presented. No result is being shown, and the threshold itself is not a validated operating point.`,
      };
    case 'no-result':
      return {
        key: `${side}.recognition`,
        label: 'Recognition',
        state: 'healthy',
        detail:
          'A model is loaded and ran on the current frame without finding a sign. That is a normal outcome, not a failure.',
      };
    case 'idle':
    default:
      return {
        key: `${side}.recognition`,
        label: 'Recognition',
        state: 'unknown',
        detail:
          'No sensor frame has been processed, so recognition has not run. This is not a statement about the model.',
      };
  }
}

/* ---------------------------------------------------------------------- app */

export interface AppAuditInput {
  readonly profile: SignLanguageProfile;
  readonly preferences: AppPreferences;
  readonly translator: Translator;
  readonly speaker: Speaker;
  /** Human name of the configured output language, for the speech row. */
  readonly targetLanguageName: string;
  /** True when the chosen output language has a TTS engine wired up. */
  readonly targetLanguageSpeechWired: boolean;
}

/** Findings that are about the app rather than about one glove. */
export function appFindings(input: AppAuditInput): Finding[] {
  const { profile, preferences, translator, speaker } = input;

  return [
    {
      key: 'app.profile',
      label: 'Sign language profile',
      // A profile whose vocabulary is empty cannot recognise anything, so
      // `healthy` would be the wrong word no matter how correct the setting is.
      state: profile.vocabularySize === 0 ? 'unavailable' : 'healthy',
      detail:
        profile.vocabularySize === 0
          ? `${profile.name} is selected and has no vocabulary defined. No sign list exists yet, and defining one is a Deaf-led linguistic task rather than an implementation detail.`
          : `${profile.name} selected, ${profile.vocabularySize} signs.`,
    },
    {
      key: 'app.translation',
      label: 'Translation',
      state: translator.isAvailable ? 'healthy' : 'unavailable',
      detail:
        translator.unavailableReason ??
        'A translator is present and reporting itself available.',
    },
    {
      key: 'app.speech',
      label: 'Speech output',
      state: speaker.isAvailable ? 'healthy' : 'unavailable',
      detail:
        speaker.unavailableReason ??
        'A speech engine is present and reporting itself available.',
    },
    {
      key: 'app.speech-language',
      label: 'Speech language coverage',
      state: input.targetLanguageSpeechWired ? 'healthy' : 'unavailable',
      detail: input.targetLanguageSpeechWired
        ? `A voice is wired up for ${input.targetLanguageName}.`
        : `No voice is wired up for ${input.targetLanguageName}, the configured output language. Android may well ship one; this build has no speech engine at all, so it can neither use nor rule one out. Preference: speech ${preferences.voiceEnabled ? 'on' : 'off'}.`,
    },
    {
      key: 'app.bluetooth',
      label: 'Bluetooth adapter and permissions',
      state: 'unknown',
      detail:
        'This screen does not query the Android Bluetooth adapter, whether it is switched on, or which runtime permissions have been granted. No API for that has been added yet, so the answer is genuinely unknown rather than assumed.',
    },
    {
      key: 'app.network',
      label: 'Network access',
      state: 'unavailable',
      detail:
        'The app has a backend client, and it is the only code here that could make a request — but no screen calls it, so nothing is sent anywhere today. Accounts, sync and vocabulary distribution would live behind that client when they are built.',
    },
  ];
}

/* ------------------------------------------------------------------ helpers */

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Wording for the counts line. Kept here so the sentence and the counts agree. */
export function describeSummary(summary: AuditSummary): string {
  if (summary.total === 0) return 'Nothing to report.';
  const parts: string[] = [];
  for (const state of ['disconnected', 'warning', 'unavailable', 'unknown', 'healthy'] as const) {
    const count = summary.counts[state];
    if (count > 0) parts.push(`${count} ${HEALTH_LABEL[state].toLowerCase()}`);
  }
  return parts.join(' · ');
}
