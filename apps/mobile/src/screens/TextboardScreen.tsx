/**
 * The conversation, under two headings.
 *
 * ## Why it is laid out this way
 *
 * One thing being said at a time, and one body of transcript below it. The
 * screen is meant to be held up between two people, so the text that matters is
 * large, dark-on-light-of-the-theme, and not competing with anything. Controls
 * sit under it rather than beside it, because a control beside a caption is a
 * control someone hits by accident while turning the phone.
 *
 * ## The three inputs, and why the provenance never collapses
 *
 * Text arrives from the glove, from the microphone, or from the keyboard. Each
 * is tagged at the point of arrival, and the tag is displayed. A transcript
 * that mixed a hardware reading with a speech service's guess and a person's
 * typing, with no way to tell them apart, would be unusable in exactly the
 * situation this app exists for — a Deaf and a hearing person in a conversation
 * where "did the phone hear that, or did the glove say it?" is a question with
 * real consequences.
 *
 * ## The microphone, and what the user is told before it opens
 *
 * Permission is requested on the press that turns captions on, never at launch,
 * and never on opening the tab. The consent line above the switch states the
 * two things a person can reasonably want to know: the audio is not recorded,
 * and the phone's recogniser may send it to a server to be transcribed. That
 * second fact is not knowable by this app — it depends on the recogniser the
 * phone has — so it is worded as what it is, a possibility, rather than being
 * hidden or over-claimed.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { ActionButton } from '../components/ActionButton';
import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { BrandHeader } from '../components/BrandHeader';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/IconButton';
import { Screen } from '../components/Screen';
import { SectionHeader } from '../components/SectionHeader';
import { useAccount } from '../account/AccountProvider';
import { useAppState, useCaptionsState, useSpeechState } from '../app/AppState';
import { SOURCE_DESCRIPTION, SOURCE_LABEL, SOURCE_TONE } from '../captions';
import { findOutputLanguage } from '../app/preferences';
import { useCopy } from '../hooks/useCopy';
import { useStyles, useTheme } from '../theme/ThemeProvider';
import type { Palette } from '../theme/palette';
import { layout, radii, spacing } from '../theme';

export interface TextboardScreenProps {
  onOpenAccount?: () => void;
}

export function TextboardScreen({ onOpenAccount }: TextboardScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { palette } = useTheme();
  const { preferences, captions, speaker: speechSpeaker } = useAppState();
  const captionsState = useCaptionsState();
  const speech = useSpeechState();
  const account = useAccount();
  const copy = useCopy();

  const [draft, setDraft] = useState('');
  /*
   * `ComponentRef<typeof ScrollView>` rather than `ScrollView`.
   *
   * In this version of React Native the exported `ScrollView` is a component
   * whose ref is an instance type, so naming the component as the ref's type
   * gives an object with no `scrollToEnd` on it. Deriving the instance type from
   * the component is what keeps this correct if either changes.
   */
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView> | null>(null);

  const language = findOutputLanguage(preferences.targetLanguageCode);

  /**
   * Whether the microphone can be offered at all.
   *
   * Three separate things have to be true: the build has the module, the device
   * has a recognition service, and the user has not permanently declined. Each
   * is reported with its own wording, because "captions need a Google app you
   * do not have" and "you turned the microphone off in Settings" call for
   * completely different actions from the user.
   */
  const microphone = useMemo(() => {
    if (captionsState.unavailableReason !== null) {
      return { usable: false, reason: captionsState.unavailableReason };
    }
    if (captionsState.permission === 'blocked') {
      return {
        usable: false,
        reason:
          'Microphone access was declined permanently. Captions stay off until it is allowed for Sanket Vaanni in your phone’s app settings.',
      };
    }
    return { usable: true, reason: null };
  }, [captionsState.unavailableReason, captionsState.permission]);

  const toggleCaptions = useCallback(async () => {
    if (captionsState.isListening) {
      await captions.stop();
      return;
    }
    try {
      await captions.start({
        languageTag: language?.speechTag ?? null,
        preferOffline: false,
      });
    } catch {
      // The controller records a readable reason in state
    }
  }, [captions, captionsState.isListening, language]);

  const sendDraft = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0) return;
    captions.addTypedLine(text);
    setDraft('');
    // The new line is at the bottom, which is where the user is looking.
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, [captions, draft]);

  const transcriptText = useMemo(
    () => captionsState.lines.map((line) => line.text).join('\n'),
    [captionsState.lines],
  );

  const hasAnything = captionsState.lines.length > 0 || captionsState.interim.length > 0;

  return (
    <Screen scroll bottomInset={layout.tabBarHeight + spacing.xl} testID="textboard-screen">
      <BrandHeader title="Textboard" onPressAvatar={onOpenAccount} />

      {/* ------------------------------------------------------- the floor */}

      <SectionHeader
        label="Conversation"
        accessory={
          hasAnything ? (
            <IconButton
              icon="trash"
              onPress={() => {
                void captions.clear();
              }}
              accessibilityLabel="Clear the transcript"
              accessibilityHint="Removes every line from this session. The microphone is not affected."
            />
          ) : undefined
        }
      />

      <View style={styles.floor}>
        <ScrollView
          ref={scrollRef}
          style={styles.transcript}
          nestedScrollEnabled
          contentContainerStyle={hasAnything ? styles.transcriptContent : styles.emptyContent}
          /*
           * Only follow the conversation when there is one. This fires for the
           * empty state too, and scrolling a message to its end cuts off its
           * start — on a short screen that hid the icon and half the heading.
           */
          onContentSizeChange={() => {
            if (hasAnything) scrollRef.current?.scrollToEnd({ animated: true });
          }}
          accessibilityLabel="Conversation transcript"
        >
          {hasAnything ? (
            <>
            {captionsState.lines.map((line) => (
              <View key={line.id} style={styles.line}>
                {/*
                  The chip is two words, which is enough for a sighted reader and
                  nothing for a screen reader. The wrapper carries the sentence,
                  and the chip itself is hidden from the accessibility tree so the
                  label is not read twice.
                */}
                <View
                  accessible
                  accessibilityLabel={SOURCE_DESCRIPTION[line.source]}
                  importantForAccessibility="yes"
                >
                  <Badge label={SOURCE_LABEL[line.source]} tone={SOURCE_TONE[line.source]} />
                </View>
                <AppText
                  variant={line.source === 'glove' ? 'heading' : 'body'}
                  style={styles.lineText}
                  selectable
                >
                  {line.text}
                </AppText>
              </View>
            ))}

            {/*
              The interim line is drawn below the settled ones and in a lighter
              colour, never merged into them. Words the recogniser is still
              revising must not read as words it has committed to — and a user
              who copies the text mid-sentence should see what they are copying.
            */}
            {captionsState.interim.length > 0 ? (
              <View style={styles.line}>
                <Badge label={SOURCE_LABEL.microphone} tone="neutral" />
                <AppText variant="body" color={palette.textMuted} style={styles.lineText}>
                  {captionsState.interim}
                  <AppText color={palette.textMuted}>…</AppText>
                </AppText>
              </View>
            ) : null}
            </>
          ) : (
            <EmptyState
              icon="chat"
              title="The transcript is empty"
              body="Turn on live captions to transcribe speech, or type below. Recognised glove gestures appear here too."
            />
          )}
        </ScrollView>
      </View>

      {/* ------------------------------------------------------ the input */}

      <SectionHeader label="Speak" />

      {microphone.usable ? (
        <Card style={styles.group}>
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <AppText variant="label">Live captions</AppText>
              <AppText variant="caption" color={palette.textMuted}>
                {captionsState.isListening
                  ? 'Listening... Speak into the phone.'
                  : 'Transcribes speech into text in real time.'}
              </AppText>
            </View>
            <ActionButton
              label={captionsState.isListening ? 'Stop' : 'Start'}
              tone={captionsState.isListening ? 'secondary' : 'primary'}
              compact
              onPress={() => {
                void toggleCaptions();
              }}
              accessibilityLabel={
                captionsState.isListening ? 'Stop listening' : 'Start listening for captions'
              }
            />
          </View>
        </Card>
      ) : (
        <Card style={styles.group}>
          <View style={styles.disclosure}>
            <Icon name="warning" size={14} color={palette.warning} />
            <AppText variant="caption" color={palette.textSecondary} style={styles.switchText}>
              {microphone.reason}
            </AppText>
          </View>
        </Card>
      )}

      {captionsState.error !== null && captionsState.listening === 'error' ? (
        <Card style={styles.errorCard}>
          <Icon name="warning" size={14} color={palette.warning} />
          <AppText variant="caption" color={palette.textSecondary} style={styles.switchText}>
            {captionsState.error}
          </AppText>
        </Card>
      ) : null}

      {/* ------------------------------------------------------- typing */}

      <SectionHeader label="Type" />

      <Card style={styles.group}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Type what you want to say"
          placeholderTextColor={palette.textMuted}
          style={[styles.input, { color: palette.textPrimary, borderColor: palette.border }]}
          multiline
          scrollEnabled
          maxLength={500}
          accessibilityLabel="Message to add to the conversation"
          onSubmitEditing={sendDraft}
        />
        <View style={styles.actionRow}>
          <ActionButton
            label="Add to transcript"
            icon="plus"
            onPress={sendDraft}
            disabled={draft.trim().length === 0}
            style={styles.grow}
          />
          <ActionButton
            label={copy.label}
            tone="ghost"
            icon={copy.status === 'copied' ? 'check' : 'copy'}
            compact
            onPress={() => {
              void copy.copy(transcriptText);
            }}
            disabled={transcriptText.length === 0}
            accessibilityLabel={
              transcriptText.length === 0
                ? 'Nothing to copy yet'
                : 'Copy the whole transcript'
            }
          />
        </View>
      </Card>

      {/* ------------------------------------------------------- speaking */}

      <SectionHeader label="Say it out loud" />
      <Card style={styles.group}>
        {!speech.available && speech.unavailableReason ? (
          <AppText variant="caption" color={palette.textSecondary}>
            {speech.unavailableReason}
          </AppText>
        ) : null}
        <ActionButton
          label={speech.isSpeaking ? 'Stop speaking' : 'Speak the last line'}
          icon="volume"
          tone="secondary"
          busy={speech.isSpeaking}
          disabled={!speech.available || captionsState.lines.length === 0}
          onPress={() => {
            const last = captionsState.lines[captionsState.lines.length - 1];
            if (last === undefined) return;
            if (speech.isSpeaking) {
              void speechSpeaker.stop();
              return;
            }
            void speechSpeaker.speak(last.text, {
              language: language?.speechTag,
            });
          }}
          accessibilityHint={
            captionsState.lines.length === 0
              ? 'There is nothing in the transcript to read'
              : 'Reads the most recent line aloud'
          }
        />
      </Card>
    </Screen>
  );
}

const makeStyles = (palette: Palette) =>
  StyleSheet.create({
    group: {
      gap: spacing.md,
    },
    /**
     * The transcript floor.
     *
     * `flex: 1` inside a non-scrolling screen: the conversation takes whatever
     * room is left after the controls, and scrolls internally. Making the whole
     * screen scroll instead would put the microphone button somewhere different
     * on every utterance, which is precisely what you do not want on a control
     * someone reaches for mid-conversation.
     */
    floor: {
      height: 240,
      minHeight: 160,
      marginBottom: spacing.md,
    },
    transcript: {
      flex: 1,
      backgroundColor: palette.surfaceSunken,
      borderRadius: radii.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    transcriptContent: {
      padding: spacing.lg,
      gap: spacing.lg,
    },
    /*
     * The empty state grows to fill the floor when there is room for it, and
     * scrolls when there is not. `flexGrow` rather than `flex` so the content
     * keeps its natural height and the scroll view, not the text, is what gives
     * way.
     *
     * Aligned to the start rather than centred: the floor is squeezed on a
     * short screen, and centring content taller than its box clips both ends —
     * which cut the icon off the top of the message. Starting at the top keeps
     * the icon and the title visible and lets the body scroll.
     */
    emptyContent: {
      flexGrow: 1,
      justifyContent: 'flex-start',
    },
    line: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    lineText: {
      flex: 1,
      minWidth: 0,
    },
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
    },
    switchText: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    disclosure: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
    },
    errorCard: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      borderColor: palette.warning,
    },
    input: {
      minHeight: 72,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radii.md,
      padding: spacing.md,
      fontSize: 15,
      lineHeight: 22,
      textAlignVertical: 'top',
    },
    actionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    grow: {
      flex: 1,
    },
    footer: {
      marginTop: spacing.md,
      marginBottom: spacing.xl,
    },
  });
