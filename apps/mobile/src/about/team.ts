/**
 * Team members shown on About Us.
 *
 * ## Every field is null, and that is the point
 *
 * The brief for this screen asks for five team members, and it also forbids
 * fabricating any team member's name, photograph, title, role, biography or
 * qualifications. Those two requirements only resolve one way: five slots, each
 * labelled with what it is waiting for, and no invented content in any of them.
 *
 * There is no plausible-looking placeholder here — no "A. Sharma, Founder &
 * CEO" — because a filled-in placeholder is indistinguishable from a real
 * person to everyone except the people who filled it in. Anything indistinguishable
 * from a fact will eventually be read as one.
 *
 * ## How to fill these in
 *
 * Replace `name`, `role` and `bio` with the real values, and add a `photo`
 * pointing at a file added to `apps/mobile/src/assets/team/`. `Avatar` renders
 * initials derived from `name` until a photo exists, so a half-filled entry
 * still looks deliberate rather than broken.
 *
 * The order is the display order.
 */
export interface TeamMember {
  /** Stable key. Used for React keys and for `testID`, not displayed. */
  readonly id: string;
  /** The person's real name, or null while it is unknown. */
  readonly name: string | null;
  /** Their real role, or null. Must not be invented. */
  readonly role: string | null;
  /** A short real biography, or null. Must not be invented. */
  readonly bio: string | null;
  /**
   * Bundled photo, or null.
   *
   * `require()` of a local file — not a remote URL. A network image here would
   * mean the About screen shows five empty circles on an offline device, which
   * is exactly the situation the rest of this app is built to avoid.
   */
  readonly photo: number | null;
}

/**
 * The five slots.
 *
 * Five because the product brief specifies five. The ids are deliberately
 * anonymous — `member-1`, not `founder` — so that filling them in does not
 * require deciding in advance which slot is which job.
 */
export const TEAM_MEMBERS: readonly TeamMember[] = [
  { id: 'member-1', name: null, role: null, bio: null, photo: null },
  { id: 'member-2', name: null, role: null, bio: null, photo: null },
  { id: 'member-3', name: null, role: null, bio: null, photo: null },
  { id: 'member-4', name: null, role: null, bio: null, photo: null },
  { id: 'member-5', name: null, role: null, bio: null, photo: null },
];

/** True when nothing about this member is known yet. */
export function isMemberUnfilled(member: TeamMember): boolean {
  return member.name === null && member.role === null && member.bio === null && member.photo === null;
}
