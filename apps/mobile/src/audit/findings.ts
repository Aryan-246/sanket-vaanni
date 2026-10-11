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
  /**
   * Which diagnostic group this row belongs to.
   *
   * Required rather than optional, and that is the whole point: a row that
   * belongs to no group would be a row the screen never draws, and a fault that
   * silently disappears from a diagnostics screen is worse than one displayed
   * badly. Making this mandatory means adding a finding forces the author to
   * decide where it is shown.
   */
  readonly group: AuditGroupKey;
  readonly label: string;
  readonly state: HealthState;
  /** What the state is based on. Never a restatement of the state word. */
  readonly detail: string;
  /** Present when the row is about a reading, so provenance can be shown. */
  readonly source?: DataSource;
  /**
   * Which glove this row is about, when it is about one.
   *
   * The groups are named by component rather than by hand — "Flex sensors", not
   * "Left glove" — because a reader investigating a fault asks about the part
   * first. The hand therefore moves onto the row.
   */
  readonly side?: GloveSide;
}

/* ------------------------------------------------------------------- groups */

/**
 * The diagnostic areas, in the order the screen shows them.
 *
 * The order runs from the physical link inward: the connection, then the
 * sensors it carries, then the computed layers, then the services that do not
 * touch a glove at all. It is fixed rather than severity-sorted so the screen
 * does not rearrange itself under the reader's finger.
 */
export type AuditGroupKey =
  | 'connection'
  | 'flex'
  | 'motion'
  | 'adc'
  | 'oled'
  | 'calibration'
  | 'recognition'
  | 'language'
  | 'services';

export const AUDIT_GROUP_ORDER: readonly AuditGroupKey[] = [
  'connection',
  'flex',
  'motion',
  'adc',
  'oled',
  'calibration',
  'recognition',
  'language',
  'services',
];

export const AUDIT_GROUP_LABEL: Record<AuditGroupKey, string> = {
  connection: 'Connection and ESP32',
  flex: 'Flex sensors',
  motion: 'Motion sensor (MPU6050)',
  adc: 'ADC and multiplexer',
  oled: 'OLED and battery',
  calibration: 'Calibration',
  recognition: 'Recognition and model',
  language: 'Language and speech',
  services: 'Offline and app services',
};

/**
 * One line saying what a group covers.
 *
 * Shown on the collapsed header. A group name alone — "ADC and multiplexer" —
 * tells a non-technical reader nothing about whether they need to open it, so
 * each group says what it is about in the same breath.
 */
export const AUDIT_GROUP_BLURB: Record<AuditGroupKey, string> = {
  connection: 'The link to each glove, whether frames arrive on it, and the controller.',
  flex: 'The five bend channels on each glove.',
  motion: 'The accelerometer and gyroscope part, and what it cannot measure.',
  adc: 'The parts that digitise the bend channels and switch between them.',
  oled: 'The panel on each glove, and the battery.',
  calibration: 'Whether bend readings have been anchored to measured positions.',
  recognition: 'The sign vocabulary, and whether a model has evaluated any input.',
  language: 'Translation, speech output, and the languages they cover.',
  services: 'Bluetooth permissions and the backend client.',
};

/** One group of findings, with the worst state among them. */
export interface AuditGroup {
  readonly key: AuditGroupKey;
  readonly label: string;
  readonly blurb: string;
  readonly findings: readonly Finding[];
  /** Worst state in this group, for the collapsed header's chip. */
  readonly worst: HealthState;
  readonly counts: Readonly<Record<HealthState, number>>;
}

function emptyCounts(): Record<HealthState, number> {
  return { healthy: 0, warning: 0, disconnected: 0, unavailable: 0, unknown: 0 };
}

/**
 * Buckets findings into the groups the screen draws.
 *
 * Groups with no findings are omitted rather than drawn empty: an empty group
 * would read as "this component reported nothing", which is a claim about
 * hardware rather than about the screen. On this build every group has rows, so
 * the distinction only matters if a group is ever added ahead of its findings.
 */
export function groupFindings(findings: readonly Finding[]): AuditGroup[] {
  return AUDIT_GROUP_ORDER.map((key): AuditGroup | null => {
    const inGroup = findings.filter((finding) => finding.group === key);
    if (inGroup.length === 0) return null;

    const counts = emptyCounts();
    for (const finding of inGroup) counts[finding.state] += 1;

    return {
      key,
      label: AUDIT_GROUP_LABEL[key],
      blurb: AUDIT_GROUP_BLURB[key],
      findings: inGroup,
      worst: worstOf(inGroup),
      counts,
    };
  }).filter((group): group is AuditGroup => group !== null);
}

/**
 * Whether a group is worth opening without being asked.
 *
 * Only a fault the user can act on opens itself: `warning` and `disconnected`
 * are the two states that mean something *is* wrong. `unavailable` and `unknown`
 * are the honest resting states of this build, and opening every group that
 * contained one would open all of them — which is the clutter the collapsed
 * layout exists to remove. Opening on a warning is what keeps a real problem
 * from hiding behind a tap.
 */
export function opensByDefault(group: AuditGroup): boolean {
  return group.worst === 'warning' || group.worst === 'disconnected';
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
  readonly nowMs: number;
}

/**
 * Findings for one glove.
 *
 * Order is fixed — link first, then data, then the components the firmware has
 * not reported on — so the screen does not reshuffle as state changes. Rows are
 * not sorted by severity on purpose: a list that reorders itself under the
 * reader's finger is worse than one that is merely unsorted.
 *
 * ## Why there is no recognition row here
 *
 * There used to be one per glove, because recognition used to be per glove: the
 * screen picked a hand and asked about that hand. It no longer is. One outcome is
 * computed for the conversation, from whichever hands the vocabulary requires,
 * and a per-glove copy of it would either duplicate the same sentence twice or
 * attribute a two-handed sign to one hand. It moved to `appFindings`, where the
 * single shared outcome is described once.
 */
export function gloveFindings(input: GloveAuditInput): Finding[] {
  const { snapshot, calibration, nowMs } = input;
  const side = snapshot.side;
  const hand = side === 'left' ? 'Left' : 'Right';
  const { link } = snapshot;

  const findings: Finding[] = [];

  /* 1 — the link itself. */
  findings.push({
    key: `${side}.link`,
    group: 'connection',
    side,
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
      group: 'connection',
      side,
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
      group: 'connection',
      side,
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
    group: 'connection',
    side,
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
    group: 'calibration',
    side,
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
    group: 'motion',
    side,
    label: 'MPU6050 IMU',
    state: 'unknown',
    detail:
      'The firmware has not reported an IMU. Accelerometer and gyroscope values appear in the frame, but nothing identifies the part, and its bias and scale are uncorrected. Wrist yaw is not observable on this part at all — it has no magnetometer.',
  });

  /* 7, 8 — the ADC and the multiplexer. */
  findings.push({
    key: `${side}.ads1115`,
    group: 'adc',
    side,
    label: 'ADS1115 ADC',
    state: 'unknown',
    detail:
      'No telemetry identifies an external ADC, and no raw channel counts have been observed — so which converter digitises the flex channels is not established.',
  });

  findings.push({
    key: `${side}.cd74hc4067`,
    group: 'adc',
    side,
    label: 'CD74HC4067 multiplexer',
    state: 'unknown',
    detail:
      'No telemetry reports a multiplexer, its channel map or its selected input. Which physical channel each finger is wired to is unverified.',
  });

  /* 9 — the panel. */
  findings.push({
    key: `${side}.oled`,
    group: 'oled',
    side,
    label: 'OLED panel',
    state: 'unknown',
    detail:
      'The firmware has not reported whether a panel is attached, what it is currently showing, or that it accepted a frame. The OLED Studio preview is a design surface and writes nothing.',
  });

  /* 10 — the pack. */
  findings.push({
    key: `${side}.battery`,
    group: 'oled',
    side,
    label: 'Battery',
    state: 'unavailable',
    detail:
      'No telemetry frame carries a battery reading, and no command to read one has been verified. A percentage here would be an invention.',
  });

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
      group: 'flex',
      side,
      label: 'Five flex channels',
      state: 'unknown',
      detail: `No reading from any channel. ${listed}.`,
      source: 'none',
    };
  }

  return {
    key: `${side}.flex`,
    group: 'flex',
    side,
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

/**
 * Recognition, as one row about the shared outcome rather than one per glove.
 *
 * Each of the six states is a different answer and none of them is "waiting".
 * The two that could be mistaken for a fault — `idle` and `no-result` — are
 * labelled `unknown` and `healthy` respectively, because neither is a failure:
 * one means nothing was evaluated, the other means something was and matched
 * nothing. A blocked state is the only one the user can act on, so it is the only
 * one whose detail names a next step.
 */
function recognitionFinding(outcome: RecognitionOutcome): Finding {
  const base = {
    key: 'app.recognition',
    group: 'recognition',
    label: 'Recognition and model',
  } as const;

  switch (outcome.kind) {
    case 'unavailable':
      return { ...base, state: 'unavailable', detail: outcome.reason };

    case 'blocked':
      return {
        ...base,
        state: 'warning',
        detail: `Not being evaluated. ${outcome.reason}`,
      };

    case 'result':
      return {
        ...base,
        state: 'healthy',
        detail: `“${outcome.candidate.label}” at ${Math.round(
          outcome.candidate.confidence * 100,
        )}% measured confidence, from ${handWords(outcome.hands)}.`,
      };

    case 'uncertain':
      /*
       * The recogniser ran and declined to commit. That is the model working as
       * designed, so it is not a fault — but it is not a result either, and the
       * wording must not let the two be confused.
       */
      return {
        ...base,
        state: 'warning',
        detail: `A candidate from ${handWords(outcome.hands)} scored ${Math.round(
          outcome.candidate.confidence * 100,
        )}%, below the ${Math.round(
          RESULT_CONFIDENCE_THRESHOLD * 100,
        )}% threshold it must clear to be presented. No result is being shown, and the threshold itself is not a validated operating point.`,
      };

    case 'no-result':
      return {
        ...base,
        state: 'healthy',
        detail:
          'A model is loaded and ran on the current input without matching a sign. That is a normal outcome, not a failure.',
      };

    case 'idle':
    default:
      return {
        ...base,
        state: 'unknown',
        detail:
          'No sensor frame has been evaluated, so recognition has not run. This is not a statement about the model.',
      };
  }
}

function handWords(hands: readonly GloveSide[]): string {
  if (hands.length === 2) return 'both hands';
  if (hands.length === 0) return 'no hand';
  return hands[0] === 'left' ? 'the left hand' : 'the right hand';
}

/* ---------------------------------------------------------------------- app */

export interface AppAuditInput {
  readonly profile: SignLanguageProfile;
  readonly preferences: AppPreferences;
  readonly translator: Translator;
  readonly speaker: Speaker;
  /** The one shared recognition outcome, for the model's row. */
  readonly recognition: RecognitionOutcome;
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
      group: 'recognition',
      label: 'Sign language profile',
      // A profile whose vocabulary is empty cannot recognise anything, so
      // `healthy` would be the wrong word no matter how correct the setting is.
      state: profile.vocabularySize === 0 ? 'unavailable' : 'healthy',
      detail:
        profile.vocabularySize === 0
          ? `${profile.name} is selected and has no vocabulary defined. No sign list exists yet, and defining one is a Deaf-led linguistic task rather than an implementation detail.`
          : `${profile.name} selected, ${profile.vocabularySize} signs.`,
    },
    recognitionFinding(input.recognition),
    {
      key: 'app.translation',
      group: 'language',
      label: 'Translation',
      state: translator.isAvailable ? 'healthy' : 'unavailable',
      detail:
        translator.unavailableReason ??
        'A translator is present and reporting itself available.',
    },
    {
      key: 'app.speech',
      group: 'language',
      label: 'Speech output',
      state: speaker.isAvailable ? 'healthy' : 'unavailable',
      detail:
        speaker.unavailableReason ??
        'A speech engine is present and reporting itself available.',
    },
    {
      key: 'app.speech-language',
      group: 'language',
      label: 'Speech language coverage',
      state: input.targetLanguageSpeechWired ? 'healthy' : 'unavailable',
      detail: input.targetLanguageSpeechWired
        ? `A voice is wired up for ${input.targetLanguageName}.`
        : `No voice is wired up for ${input.targetLanguageName}, the configured output language. Android may well ship one; this build has no speech engine at all, so it can neither use nor rule one out. Preference: speech ${preferences.voiceEnabled ? 'on' : 'off'}.`,
    },
    {
      key: 'app.bluetooth',
      group: 'services',
      label: 'Bluetooth adapter and permissions',
      state: 'unknown',
      detail:
        'This screen does not query the Android Bluetooth adapter, whether it is switched on, or which runtime permissions have been granted. No API for that has been added yet, so the answer is genuinely unknown rather than assumed.',
    },
    {
      key: 'app.network',
      group: 'services',
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
