/**
 * Notices — published announcements, as the app is allowed to see them.
 *
 * A barrel, matching `../maintenance`, so the rest of the app imports one module
 * and the pieces stay swappable behind it: `useNotices` in `../app/AppState` and
 * `NoticesCard` in `../components` are the only consumers.
 */
export {
  AnnouncementsReader,
  INITIAL_ANNOUNCEMENTS_STATE,
  MAX_DISMISSED,
  NOTICE_LIMIT,
  READ_TIMEOUT_MS,
  dedupeById,
  isLive,
  parseNotice,
  selectVisible,
  shouldShowNotices,
  sortNotices,
} from './reader';

export type {
  AnnouncementsDeps,
  AnnouncementsRead,
  AnnouncementsState,
  AnnouncementsStatus,
  Notice,
} from './reader';
