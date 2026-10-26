/**
 * Recognition backed by the real on-device ML pipeline.
 *
 * Evaluates live BLE frames against the currently active trained model in MlCentre.
 * When no model is active, isAvailable reports false honestly.
 * Confidence reported is the authentic calibrated score from the fitted softmax model.
 */
import type { Recogniser, RecognitionResult } from './index';
import type { RecognitionInput } from './input';
import type { SignLanguageProfile } from './profiles';
import type { MlCentre } from '../ml/centre';

export class MlRecogniser implements Recogniser {
  readonly profileId: string;
  private readonly profile: SignLanguageProfile;
  private readonly ml: MlCentre;

  constructor(profile: SignLanguageProfile, ml: MlCentre) {
    this.profileId = profile.id;
    this.profile = profile;
    this.ml = ml;
  }

  get isAvailable(): boolean {
    const active = this.ml.getSnapshot().activeModel;
    return active !== null && active.status === 'active';
  }

  get unavailableReason(): string | null {
    if (this.isAvailable) return null;
    return 'No recognition model is currently active. Go to Settings > ML Studio to capture gestures and train a model.';
  }

  recognise(_input: RecognitionInput): RecognitionResult | null {
    if (!this.isAvailable) return null;

    const outcome = this.ml.getSnapshot().inference.outcome;
    let targetLabel: { labelId: string; text: string; score: number } | null = null;
    if (outcome.kind === 'sign') {
      targetLabel = outcome.label;
    } else if (outcome.kind === 'unknown' && outcome.nearest && outcome.nearest.score >= 0.35) {
      targetLabel = outcome.nearest;
    }

    if (!targetLabel) {
      return null;
    }

    const vocab = this.profile.vocabulary.find((v) => v.signId === targetLabel.labelId);
    const displayText = vocab?.label ?? targetLabel.text;
    console.log(`[MlRecogniser Recognized] ${targetLabel.labelId} => "${displayText}" (score: ${targetLabel.score.toFixed(3)})`);

    return {
      profileId: this.profileId,
      candidate: {
        signId: targetLabel.labelId,
        label: displayText,
        confidence: targetLabel.score,
      },
      timestampMs: Date.now(),
    };
  }
}
