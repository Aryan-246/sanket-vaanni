/**
 * What the app says about signing as it happens, and what it refuses to say.
 *
 * ## Three answers, and two of them are "I do not know"
 *
 * `inference.ts` can return a sign, "not sure", or "nothing to go on". This screen
 * renders whichever came back and never improves on it: a low score is shown as a
 * low score, a stalled stream says the reading is out of date, and a model that
 * this build cannot read says so instead of scoring something.
 *
 * That matters more here than anywhere else in the app. A frozen "sign" on a
 * screen looks exactly like a recognised one, and the person reading it has no way
 * to tell the difference — so the stale case is drawn as a distinct state rather
 * than as the last answer left standing.
 *
 * ## Live evaluation is turned on by *this screen being on*
 *
 * The centre holds a second buffer for live inference and only fills it while
 * `setLiveUpdates(true)` is in force, which this area does on mount and undoes on
 * unmount. Evaluating every frame while nobody is looking costs battery for a
 * figure no one can see, and the buffer is cleared on the way out so a reading
 * taken minutes ago is never the first thing shown next time.
 *
 * ## Why correction hands off instead of saving here
 *
 * A live window has no session, no calibration record and no provenance: it is a
 * rolling buffer, re-sliced on every frame. Storing it as a training example from
 * this screen would mean inventing all of that here — a second sample-writing path
 * that the recorder, the duplicate check and the session-aware split would not
 * know about. So "that was not the sign" explains where the example actually gets
 * made, and takes the person there. The correction itself is real: it is the
 * record-then-label flow, and the library's relabel for a window already stored.
 */
import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../../components/AppText';
import { ActionButton } from '../../components/ActionButton';
import { Badge, type BadgeTone } from '../../components/Badge';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { LIVE_NOTE, SCORE_NOTE, WINDOW_FRAMES } from '../../ml';
import type { UnknownReason } from '../../ml';
import { spacing } from '../../theme';
import { useStyles, useTheme } from '../../theme/ThemeProvider';
import type { Palette } from '../../theme/palette';
import { Meter, NoteCard, Row, Section } from './shared';
import { useMl, useMlData, useMlSnapshot } from './hooks';
import type { MlArea } from './areas';

/**
 * How each refusal to name a sign is introduced.
 *
 * The reasons are codes in the model and sentences for a person here, so a new
 * code cannot reach the screen as `below-floor`.
 */
const UNKNOWN_TITLE: Record<UnknownReason, string> = {
  'no-model': 'Nothing has been trained yet',
  'no-active-model': 'No model is switched on',
  'incompatible-model': 'This model cannot be read by this build',
  collecting: 'Still collecting motion',
  stale: 'The glove has gone quiet',
  'unusable-window': 'That window could not be read',
  'too-close': 'Two signs scored too closely',
  'below-floor': 'Nothing scored high enough',
};

const UNKNOWN_TONE: Record<UnknownReason, BadgeTone> = {
  'no-model': 'neutral',
  'no-active-model': 'warning',
  'incompatible-model': 'danger',
  collecting: 'neutral',
  stale: 'warning',
  'unusable-window': 'danger',
  'too-close': 'warning',
  'below-floor': 'warning',
};

export function LiveArea({ onOpenArea }: { onOpenArea: (area: MlArea) => void }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const ml = useMl();
  const data = useMlData();
  const snapshot = useMlSnapshot();

  const inference = snapshot.inference;
  const active = snapshot.activeModel;

  /*
   * Live evaluation is tied to this screen being open, not to a switch. A switch
   * would survive navigating away and leave a buffer filling behind four other
   * screens; the effect's cleanup cannot.
   */
  useEffect(() => {
    ml.setLiveUpdates(true);
    return () => ml.setLiveUpdates(false);
  }, [ml]);

  const outcome = inference.outcome;

  return (
    <View style={styles.areas}>
      {/* ---------------------------------------------------------- what is live */}

      <Section
        label="Right now"
        detail="Read from the glove's own frames as they arrive. Nothing is uploaded and no server is involved."
      >
        <Card style={styles.stack}>
          <View style={styles.headRow}>
            <Badge
              label={inference.receiving ? 'Reading' : 'No motion arriving'}
              tone={inference.receiving ? 'success' : 'warning'}
              dot
            />
            {active === null ? (
              <Badge label="No model in use" tone="neutral" />
            ) : (
              <Badge label={`v${active.version} in use`} tone="accent" />
            )}
          </View>

          <Meter
            testID="live-buffer"
            value={Math.min(inference.buffered / WINDOW_FRAMES, 1)}
            label={`${Math.min(inference.buffered, WINDOW_FRAMES * 2)} of ${WINDOW_FRAMES} readings held`}
            unknown="No readings have arrived since this screen opened."
          />
          <AppText variant="caption" color={palette.textMuted}>
            A window is {WINDOW_FRAMES} readings. The buffer is cleared the moment this screen is
            left, so a reading taken earlier is never shown as the current one.
          </AppText>

          {!inference.receiving && active !== null ? (
            <NoteCard tone="warning" testID="live-not-receiving">
              No frames are arriving. Connect a glove, or switch on Demo Mode for a hand — until then
              there is nothing to read, and whatever was on screen before this is out of date.
            </NoteCard>
          ) : null}
        </Card>
      </Section>

      {/* --------------------------------------------------------------- the answer */}

      <Section
        label="What it makes of it"
        detail={
          active === null
            ? 'There is no model in use, so nothing can be named.'
            : 'One of three answers: a sign, "not sure", or nothing to go on. There is no fourth answer that guesses.'
        }
      >
        {outcome.kind === 'sign' ? (
          <Card style={styles.stack} accentBorder testID="live-sign">
            <AppText variant="overline" color={palette.textMuted}>
              It reads this as
            </AppText>
            <AppText variant="result" color={palette.textPrimary}>
              {outcome.label.text}
            </AppText>
            <AppText variant="caption" color={palette.textSecondary}>
              The next sign scored {formatScore(outcome.margin)} lower. The score for this one was{' '}
              {formatScore(outcome.label.score)}.
            </AppText>
            <AppText variant="caption" color={palette.textMuted}>
              {SCORE_NOTE}
            </AppText>
          </Card>
        ) : (
          <Card style={styles.stack} testID="live-unknown">
            <View style={styles.headRow}>
              <AppText variant="overline" style={styles.grow} color={palette.textMuted}>
                It is not naming a sign
              </AppText>
              <Badge label={UNKNOWN_TITLE[outcome.reason]} tone={UNKNOWN_TONE[outcome.reason]} dot />
            </View>
            <AppText variant="body" color={palette.textSecondary}>
              {outcome.detail}
            </AppText>

            {outcome.nearest !== null ? (
              <AppText variant="caption" color={palette.textMuted}>
                The closest sign was “{outcome.nearest.text}”, which is shown as the closest and not
                as an answer. It scored {formatScore(outcome.nearest.score)}
                {outcome.margin === null ? '' : `, ${formatScore(outcome.margin)} ahead of the next`}.
              </AppText>
            ) : (
              <AppText variant="caption" color={palette.textMuted}>
                Nothing was scored at all, so there is not even a closest sign to show.
              </AppText>
            )}

            {outcome.reason === 'collecting' ? (
              <AppText variant="caption" color={palette.textMuted}>
                This is normal for the first window and after a hand swap. It clears itself.
              </AppText>
            ) : null}
          </Card>
        )}

        {active === null ? (
          <EmptyState
            icon="scan"
            title="Nothing is in use"
            body={
              data.models.length > 0
                ? `${data.models.length} version${data.models.length === 1 ? '' : 's'} exist, but none passed the checks to go live. Open Models to see why, and to use one anyway if you judge it worth trying.`
                : 'No model has been trained on this phone yet. Recognising live needs one, and one needs confirmed recordings and a training run.'
            }
            action={
              <ActionButton
                label="Open Models"
                tone="secondary"
                onPress={() => onOpenArea('models')}
              />
            }
          />
        ) : null}
      </Section>

      {/* ----------------------------------------------------------- the ranking */}

      {outcome.kind === 'sign' || outcome.alternatives.length > 0 ? (
        <Section
          label="How they ranked"
          detail="Every sign the model knows, highest first. Shown so a near-tie is visible rather than hidden behind the top row."
        >
          <Card style={styles.stack}>
            {outcome.alternatives.map((scored, index) => (
              <Row key={scored.labelId} last={index === outcome.alternatives.length - 1}>
                <View style={styles.headRow}>
                  <AppText variant="label" style={styles.grow}>
                    {scored.text}
                  </AppText>
                  <AppText variant="reading" color={palette.textSecondary}>
                    {formatScore(scored.score)}
                  </AppText>
                </View>
                <Meter
                  value={Math.min(Math.max(scored.score, 0), 1)}
                  label={`${scored.text} ranked ${index + 1}`}
                  unknown="This sign was not scored."
                />
              </Row>
            ))}
          </Card>
          <NoteCard>{LIVE_NOTE}</NoteCard>
        </Section>
      ) : null}

      {/* ---------------------------------------------------------- the settings */}

      <Section
        label="When it is allowed to answer"
        detail="Two thresholds you set. They decide when the app stays quiet, not how confident it is."
      >
        <Card style={styles.stack}>
          <AppText variant="caption" color={palette.textSecondary}>
            It answers only when the best sign scores at least{' '}
            {formatScore(data.settings.unknownScore)} and leads the next by at least{' '}
            {formatScore(data.settings.unknownMargin)}. Otherwise it says it is not sure, and shows
            what came closest.
          </AppText>
          <NoteCard testID="live-threshold-note">
            These are thresholds, not confidences. Nothing measured how often a score of 0.8 is
            right, so they are not calibrated — they are a line you drew below which the app keeps
            quiet. Raising them makes it answer less often.
          </NoteCard>
        </Card>
      </Section>

      {/* --------------------------------------------------------- the correction */}

      <Section
        label="If it got it wrong"
        detail="A misread sign is the most useful thing you can record, and the app cannot record it for you without asking."
      >
        <Card style={styles.stack}>
          <AppText variant="caption" color={palette.textSecondary}>
            The motion behind a live reading is held in a rolling buffer and is not stored — it has no
            session, no calibration record and no provenance, and filing it as an example from here
            would mean inventing all three. So a correction is made the way every other example is:
            the motion is recorded, and you say what it was.
          </AppText>
          <ActionButton
            label="Record it as an example"
            tone="secondary"
            icon="scan"
            onPress={() => onOpenArea('record')}
          />
          <AppText variant="caption" color={palette.textMuted}>
            If the window has already been saved and is wrong, the sign can be changed on it in the
            library without recording anything again.
          </AppText>
          <ActionButton
            label="Open the library"
            tone="ghost"
            onPress={() => onOpenArea('dataset')}
          />
        </Card>
      </Section>
    </View>
  );
}

/** A score to two decimals, as text. Never labelled as a probability. */
function formatScore(value: number): string {
  return `${Math.round(value * 100) / 100}`;
}

const makeStyles = (_palette: Palette) =>
  StyleSheet.create({
    areas: {
      gap: spacing.lg,
    },
    stack: {
      gap: spacing.md,
    },
    grow: {
      flex: 1,
      minWidth: 0,
    },
    headRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
  });
