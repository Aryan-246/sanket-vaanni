/**
 * The learning centre's areas, and why there are five.
 *
 * The directive lists eleven things the centre has to contain. They are not
 * eleven screens: five areas hold all of them, grouped by what a person is
 * actually doing — looking at the state, recording, working with the data,
 * training and evaluating, or watching it recognise. Each area is reachable from
 * the overview and from the segmented control, so nothing is buried.
 *
 * The count is five for the same reason the app has five tabs: a segmented
 * control on a phone fits that many labels at a readable size. Seven labels would
 * either clip or shrink below the minimum touch target, and a label nobody can
 * read is a feature nobody can find.
 *
 * The third area is called *Library* rather than *Dataset* because it holds more
 * than the windows: the signs, the imported photos and video, and export, restore
 * and deletion. A label that promised only windows would hide the rest.
 */
export type MlArea = 'overview' | 'record' | 'dataset' | 'models' | 'live';

export interface MlAreaOption {
  readonly value: MlArea;
  readonly label: string;
}

export const ML_AREAS: readonly MlAreaOption[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'record', label: 'Record' },
  { value: 'dataset', label: 'Library' },
  { value: 'models', label: 'Models' },
  { value: 'live', label: 'Live' },
];
