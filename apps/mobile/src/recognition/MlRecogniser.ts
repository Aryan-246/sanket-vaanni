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
  private readonly ml: MlCentre;

  constructor(profile: SignLanguageProfile, ml: MlCentre) {
    this.profileId = profile.id;
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
    if (outcome.kind !== 'sign') {
      return null;
    }

    const { label } = outcome;
    return {
      profileId: this.profileId,
      candidate: {
        signId: label.labelId,
        label: label.text,
        confidence: label.score,
      },
      timestampMs: Date.now(),
    };
  }
}
