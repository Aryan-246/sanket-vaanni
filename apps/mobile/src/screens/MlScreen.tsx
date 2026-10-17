/**
 * The learning centre: five areas over one wired centre.
 *
 * ## What changed here, and why
 *
 * This screen used to be a written account of what was missing — no dataset, no
 * training run, no held-out measurement, no vocabulary — with a list of the
 * engineering steps between here and recognition. Most of that list is no longer
 * true: there is now a window pipeline, a classifier fitted on the phone, a
 * session-aware split, a measured evaluation and stored versions. Leaving the list
 * up would have turned an honest screen into a false one, so it is gone.
 *
 * The part of it that is still true — that no sign vocabulary is published, and
 * that every profile in Settings is still marked planned with no signs — is kept,
 * in the overview, beside the definitions the user actually makes.
 *
 * ## Why a segmented control rather than nested navigation
 *
 * The app's navigation is hand-rolled and one level deep: a detail screen is
 * pushed and popped, with no route parameters. Adding a second level of routes
 * for the learning centre would mean rebuilding that, which is a change to the
 * shell of the app rather than to this feature. `AdminScreen` already solved the
 * same problem the same way — one screen, a segmented control, its own areas —
 * so this follows it.
 *
 * ## Every area is reachable, and nothing on them is a placeholder
 *
 * The areas read from `MlCentre`, which is built once in `AppState` from the real
 * storage, the real glove controllers and the real picker. No screen here invents
 * a figure: where something has not happened, it says so, and where it is blocked
 * it names whose decision the block is.
 */
import React, { useState } from 'react';
import { View } from 'react-native';

import { DetailHeader } from '../components/DetailHeader';
import { Screen } from '../components/Screen';
import { SegmentedControl } from '../components/SegmentedControl';
import { DatasetArea } from './ml/DatasetArea';
import { LiveArea } from './ml/LiveArea';
import { MediaSection } from './ml/MediaSection';
import { ModelsArea } from './ml/ModelsArea';
import { OverviewArea } from './ml/OverviewArea';
import { RecordArea } from './ml/RecordArea';
import { TransferSection } from './ml/TransferSection';
import { ML_AREAS, type MlArea } from './ml/areas';

export interface MlScreenProps {
  onClose: () => void;
}

/**
 * What each area is for, under the title.
 *
 * Written per area because a fixed subtitle would have to be vague enough to fit
 * all five, and a vague line at the top of a screen is worse than none.
 */
const SUBTITLE: Record<MlArea, string> = {
  overview: 'What is connected, what is set, and what is missing',
  record: 'Record motion, then say what it was',
  dataset: 'The signs, the windows, the files and the exports',
  models: 'Training a version, measuring it, and putting it into use',
  live: 'What it makes of your signing as it happens',
};

export function MlScreen({ onClose }: MlScreenProps): React.JSX.Element {
  const [area, setArea] = useState<MlArea>('overview');

  return (
    <Screen scroll testID="ml-screen">
      <DetailHeader title="Models and vocabulary" onClose={onClose} subtitle={SUBTITLE[area]} />

      <SegmentedControl
        options={ML_AREAS}
        value={area}
        onChange={setArea}
        accessibilityLabel="Learning centre area"
        dense
      />

      {/*
        Each area is its own component with its own state, so switching areas
        discards a half-finished form rather than carrying it into another one.
        What does *not* live in a component is the centre itself: it is built once
        in `AppState` and survives every switch, which is what makes a recording
        session continue while the user looks at the library.
      */}
      {area === 'overview' ? <OverviewArea /> : null}
      {area === 'record' ? <RecordArea onOpenArea={setArea} /> : null}
      {area === 'dataset' ? (
        <View>
          <DatasetArea />
          <MediaSection />
          <TransferSection />
        </View>
      ) : null}
      {area === 'models' ? <ModelsArea /> : null}
      {area === 'live' ? <LiveArea onOpenArea={setArea} /> : null}
    </Screen>
  );
}
