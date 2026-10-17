# Mobile screen and navigation review — §5 of the completion directive

**Date:** 2026-10-15
**Directive point verified:** *"Review every existing mobile screen and navigation flow. Build/install the current APK non-destructively if possible, reconnect the actual Android device if available, and capture screenshots of each screen and important state. Inspect clipping, overlapping content, spacing, typography, dark/light themes if supported, navigation, touch targets, loading, empty, error and retry states. Do not claim visual or physical-device verification if the device is unavailable. Do not redesign the Dashboard; report any proposed visual changes separately for my approval."*

## Verdict and, first, what this is not

This is a **source-level** review. It is not a visual review, and nothing in it is
evidence about how the app looks.

**No Android device is attached.** At the time of writing:

```
$ adb devices -l
List of devices attached
```

Empty. An earlier session on the same day did use a real handset, recorded in
`docs/device-verification-2026-10-15.md`, and it covered **three screens**; that
record states plainly that the Admin half of the review was outstanding, and no
screenshot file is referenced anywhere in this repository for the Admin work.
`docs/admin-phase-final-report.md:180-181` is explicit that no screenshots are offered
as evidence.

So the honest position is:

| Claim | Status |
|---|---|
| Every screen's code inspected | **Yes** — §2–§7 |
| Navigation graph traced from source | **Yes** — §3 |
| Loading / empty / error / retry states enumerated per screen | **Yes** — §4 |
| Touch targets measured from StyleSheets | **Yes** — §5 |
| Dark/light themes exist and how they resolve | **Yes** — §6 |
| Clipping risks identified from the source | **Yes** — §7 |
| **How any of it actually looks** | **NOT VERIFIED** |
| **Clipping on a real screen, at real font scaling** | **NOT VERIFIED** |
| **Screenshots of each screen and state** | **NOT CAPTURED** |
| **TalkBack, contrast, reduced motion, dynamic type on device** | **NOT TESTED** |
| **Admin screens on a physical device** | **NEVER RUN ON HARDWARE** |

Everything below is therefore a statement about what the code will do, and the
sections are written so that the parts needing a device are named as such rather than
blurred.

---

## 1. Screen and navigation inventory

One navigator exists. A repository-wide search for `NavigationContainer` or
`createNativeStackNavigator` returns nothing outside comments — navigation is
hand-rolled in `apps/mobile/src/app/RootNavigator.tsx`, described in its own comment
(`:40-45`) as *"a stack of depth one"*: every detail screen is pushed from a tab and
pops back to it.

**Model** (`RootNavigator.tsx:54-57`)

```ts
type Route = 'intro' | 'tabs';
export type DetailKey = 'audit' | 'profile' | 'about' | 'admin' | 'ml';
```

**Tabs** — `dashboard`, `oled`, `textboard`, `history`, `more`
(`RootNavigator.tsx:315-350`).

**Detail screens**

| Key | Component | File | Opened from | Guard |
|---|---|---|---|---|
| `audit` | `AuditScreen` | `src/screens/AuditScreen.tsx` | More (`:334`) | none |
| `profile` | `ProfileScreen` | `src/screens/ProfileScreen.tsx` | More (`:335`); auth deep link (`:106-111`) | none |
| `about` | `AboutScreen` | `src/screens/AboutScreen.tsx` | More (`:336`) | none |
| `admin` | `AdminScreen` | `src/screens/AdminScreen.tsx` | More, only when `canOpenAdmin` (`:345`); maintenance auto-open (`:234-236`) | `detail === 'admin' && isAdmin` (`:299`) |
| `ml` | `MlScreen` | `src/screens/MlScreen.tsx` | Admin console only (`:302`) | `detail === 'ml' && isAdmin` (`:286`) |

**Non-route screens:** `MaintenanceScreen` is a hard gate rendered **instead of** the
tabs (`:238-263`), and `IntroScreen` is the launch sequence (`:265-267`).

**Inside `MlScreen`:** five areas selected by a segmented control — `OverviewArea`,
`RecordArea`, `DatasetArea`, `ModelsArea`, `LiveArea` (`src/screens/ml/`) — plus
`MediaSection` and `TransferSection` embedded within them. These are not navigator
routes; they are local state.

### Two deliberate decisions worth recording

**The Admin row is absent rather than refused.** `MoreScreen`'s admin entry is passed
as `undefined` when the account is not an administrator
(`RootNavigator.tsx:342-345`), so it is not drawn. A row that is drawn and then refuses
teaches a non-administrator that a console exists behind a door they cannot open.

**`ml` has no entry point of its own.** `RootNavigator.tsx:337-341` records the choice
explicitly, and its only opener is the Admin console — which is what keeps the ML
management surface inside Admin, as the directive requires. It is a genuine
single-entry guarantee, not a convention.

### Gating: `isAdmin` vs `canOpenAdmin`

`canOpenAdmin = isReady && isAdmin` (`:157`) gates the *entry points*, so nothing is
offered while the role is still unknown. The *render* guards use `isAdmin` alone
(`:286`, `:299`) — deliberately, per the comment at `:275-298`: using `canOpenAdmin`
would mean a profile refresh mid-session could tear an open console away from an
administrator who is still an administrator.

### Back navigation

- Every detail screen receives `onClose={closeDetail}` (`:272-311`); `DetailHeader`
  draws the back affordance; `TabBar` is hidden while a detail is open (`:355-357`).
- **Android hardware back** (`:171-190`): closes the account sheet → pops the detail →
  returns a non-dashboard tab to `dashboard`. On the dashboard with nothing open the
  handler is **not registered** (`:174`), so back exits the app.
- **iOS has no in-app back gesture** — there is no navigator library, so no swipe-back.
  The header button is the only way back. This is a real platform asymmetry and is
  recorded here rather than discovered later.
- **Screens with no back affordance:** `MaintenanceScreen` (the app is closed; its
  exits are "Check now" and "Sign in" — `:188-196`) and `IntroScreen` (self-completing).
  Both appear intentional.
- **Routes defined but never opened: none.** All five `DetailKey`s have at least one
  opener.

---

## 2. Per-screen states

"absent" means the state does not exist in that screen. The directive asks for loading,
empty, error and retry specifically, so those four are the columns.

| Screen | Loading | Empty | Error | Retry |
|---|---|---|---|---|
| `DashboardScreen` | absent — no spinner; state is carried by the orb and glove strip | via `DetectedTextCard` empty copy (`:209-215`, `:270-271`) | absent | absent |
| `OledScreen` | text "Reading your saved profiles…" (`:376-379`), no spinner | empty-layout card (`:515-521`); overflow warning (`:483-500`) | absent as a fetch-error state | absent |
| `TextboardScreen` | absent | `EmptyState` (`:231-236`) | error `Card` when listening has failed (`:308-315`); mic-unusable card (`:293-306`) | no explicit retry; the mic controls are the recovery |
| `HistoryScreen` | deliberate blank placeholder, height 96 (`:210-214`) | two variants — "Nothing matches" (`:218-234`), "Nothing has been recognised yet" (`:236-251`) | absent | absent (empty state offers "Clear search") |
| `MoreScreen` | absent | `NoticesCard` owns its own (`:192`) | notices error via `NoticesCard` | **notices retry** (`:176`, wired `:192`) |
| `ProfileScreen` | busy states on buttons | absent | inline status message (`:95`, `:122`, `:281`) | no explicit retry; re-press |
| `AboutScreen` | absent | absent** | absent | absent |
| `AuditScreen` | absent | absent | language-check failure recorded (`:140-144`) | per-controller `retry()` (`:203`) |
| `AdminScreen` | `Loading` component (`:268-278`) in 7 places: overview `:2030`, people `:609`, audit `:1290`, notices `:1657`, service `:2520`, health `:2262`, provisioning `:2381` | `EmptyState` per section: no-backend `:211`, people `:704-710`, audit `:1292-1308`, notices `:1666-1675`, overview `:2034-2055` | `Failure` card (`:306-350`), rendered in 8 places | `Failure.onRetry` wired in every section; the 401 case offers **"Sign in again"** instead (`:345-347`) |
| `MlScreen` | delegates to areas | delegates | delegates | delegates |
| `MaintenanceScreen` | countdown re-read every 10 s (`:88-103`) | n/a | orb `state="error"` (`:128-131`) | "Check now" (`:188-196`) |
| `IntroScreen` | video load + watchdog (`onError` `:439-444`) | n/a | every failure path resolves to `onComplete` (`:216`, `:444`) | n/a — falls back rather than retries |

\*\* `AboutScreen` renders a blank placeholder for build values while they are unknown
(`:176-186`). That is an absent-value state rather than an empty-state design.

**ML areas** carry their own `EmptyState`s — `RecordArea:230`, `ModelsArea:326`,
`LiveArea:202`, `DatasetArea:163/224/288`, `MediaSection:181/252` — and `AdminScreen`'s
`MlSection` surfaces a readiness badge (`:2711-2715`) and an error (`:2760-2764`).

### What this table shows

**The Admin console is the only surface with all four states complete, and it is the
one just worked on.** That is the expected shape — it is the newest code, and the §4
gap-closure pass explicitly targeted authorization and error states.

**Three screens have no error state at all: `DashboardScreen`, `OledScreen` and
`HistoryScreen`.** For `OledScreen` and `HistoryScreen` this is defensible — both read
local storage that is present or absent rather than a service that can fail. For
`DashboardScreen` it is worth noting: it depends on the glove link and on recognition,
and the account sheet path aside, it has no failure surface of its own. That is not a
defect the audit will assert without seeing it on a device.

**`TextboardScreen` and `ProfileScreen` have no explicit retry.** Both rely on the user
re-pressing the control that failed, which is a reasonable design where the control is
the retry.

---

## 3. Touch targets

The app has a stated floor and it is enforced in the shared components:

```ts
export const MIN_TOUCH_TARGET = 48;   // src/theme/index.ts:100 — comment cites Android 48 dp
```

| Component | Visual size | Effective | Verdict |
|---|---|---|---|
| `ActionButton` | `minHeight` 48 (`:111`); compact 44 (`:129`) | 48 / 44 | meets floor |
| `ListRow` | `minHeight` 48 (`:125`) | 48 | meets floor |
| `SegmentedControl` | `minHeight` 44 (`:99`) | 44 | meets floor |
| `TextField` | `minHeight` 48 (`:81`) | 48 | meets floor |
| `TabBar` item | `height` 60 (`theme/index.ts`) | 60 | meets floor |
| `CollapsibleSection` | header `minHeight` 48 (`:101`), whole header pressable | 48 | meets floor |
| `Avatar` | `hitSlop` computed to reach 48 (`:153`) | 48 | meets floor |
| `Toggle` | track 46×28 (`:17-19`) | ~70×52 via `hitSlop` 12 (`:68`) | meets floor |
| `IconButton` | 36×36 (`:74-81`) | 52 via `hitSlop` 8 (`:56`) | meets **only with** `hitSlop` |
| `Sheet` close | 32×32 (`:259`) | 56 via `hitSlop` 12 (`:172`) | meets **only with** `hitSlop` |
| `HandViewer` preset chip | 40 (`:433`) | 56 via `hitSlop` 8 (`:279`) | meets **only with** `hitSlop` |
| `orb/OrbStage` | — | `hitSlop` 16 (`:98`) | meets floor |
| `IntroScreen` | — | `hitSlop` 12 (`:513`) | meets floor |

`hitSlop` has **7 real call sites**: `Avatar:153`, `HandViewer:279`, `IconButton:56`,
`Sheet:172`, `orb/OrbStage:98`, `Toggle:68`, `IntroScreen:513`. (Four other matches are
comments.)

**Four controls are below 44 dp visually and rely entirely on `hitSlop`:** `IconButton`
(36), `Sheet`'s close (32), `HandViewer`'s preset chip (40) and `Toggle`'s track (28).
`hitSlop` is the correct mechanism and all four use it — but it is a compile-time
constant that a future refactor can drop silently, and there is no test asserting it.
That is a genuine, cheap gap and is listed as such in §8.

**No component was found with a touch target below 44 dp once `hitSlop` is counted.**

---

## 4. Theming

**Dark and light both exist, plus a system option that follows the OS.** This is
verified from the code, not assumed:

- `ThemeMode = 'system' | 'dark' | 'light'` (`src/app/preferences.ts:15`), with
  `THEME_MODES` at `:17`.
- Two complete palettes: `darkPalette` (`src/theme/palette.ts:252`) and
  `lightPalette` (`:294`), resolved by `resolvePalette(scheme, accent)` (`:336`),
  indexed by `PALETTES` (`:353`).
- The OS is read at `ThemeProvider.tsx:68` (`useColorScheme()`) and honoured at the
  scheme resolution step:
  ```ts
  const scheme = mode === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : mode;
  ```
  (`:116-117`). So `system` follows the OS, and `dark`/`light` override it.
- **Default is `'dark'`** (`:69`), with accent `'emerald'` (`:70`). The stored
  preference is applied on mount (`:73-96`) and written through on change (`:98-106`).
- User-facing control: More → "Appearance" `SegmentedControl` (`MoreScreen.tsx:303-314`),
  with copy stating the choice is saved on-device and needs no account (`:311-313`).
- Five accent palettes exist (`palette.ts:136`), changeable from the orb stage
  (`OrbStage.tsx:66`, `:76`, `:134`) and persisted (`ThemeProvider.tsx:108-114`).
- The status bar and root background track the palette centrally (`RootNavigator.tsx:388-392`).
- Styles are rebuilt per palette via `useStyles(factory)`, memoised on
  `[factory, palette]` (`ThemeProvider.tsx:149-152`).

**There is no in-app text-size override.** `MoreScreen.tsx:325-329` states "Follows
system … no in-app override", and `AppText` caps scaling centrally at
`maxFontSizeMultiplier={1.4}` (`src/components/AppText.tsx:42`), explained at `:22` as
a consequence of the dense layout.

**This makes 1.4× the worst case the code is designed for, and it is exactly the
condition under which the clipping risks in §5 appear.** It has never been observed on
a device.

---

## 5. Clipping and typography

### The structural finding

**`ellipsizeMode`, `adjustsFontSizeToFit` and `minimumFontScale` appear nowhere in
`apps/mobile/src`.** A repository-wide search returns zero matches. Every line-capped
text node therefore truncates with the React Native default — an ellipsis at the tail —
and there is no mitigation available at any site.

That is a coherent choice, not an oversight: the app capping scaling at 1.4× is the
same decision made once, centrally. But it means **each `numberOfLines` site is a
place where variable text can be cut, and the mitigation is layout, not typography.**

### Where line caps meet variable text

Ranked by exposure. All of these hold text whose length is not bounded by the app.

1. **`TranslatorPanel.tsx:199`** — `outcome.text`, `variant="title"`,
   `numberOfLines={3}`. The translated sentence. Highest exposure in the app: it is
   model output of arbitrary length, rendered at the largest type variant, capped at
   three lines.
2. **`VoicePanel.tsx:123`** — the phrase that "Would speak", `variant="reading"`,
   `numberOfLines={1}`, with `flexShrink: 1` on the row (`:227`). A long recognised or
   typed phrase is ellipsised to one line.
3. **`RecognitionPanel.tsx:108`** — `candidate ?? shortState(outcome)`,
   `numberOfLines={3}`. `shortState` is fixed copy; `candidate` is a recognised label
   and can be long.
4. **`ListRow.tsx:77`** — `numberOfLines={1}` with `flexShrink: 1` (`:151`). The
   generic value slot, used app-wide for profile values, admin data and model metadata.
   Anything long is cut, and the component is shared, so the exposure is not one screen.
5. **`AdminScreen.tsx:854-860`** — display name and email, each `numberOfLines={1}`.
   Long addresses are truncated in the People list. This is a screen where the reader
   is trying to identify an account.
6. **`Badge.tsx:57`** — `numberOfLines={1}` with `flexShrink: 1` (`:75`). Labels
   include server-derived tokens: `user.role` (`AdminScreen.tsx:867`), `item.severity`
   (`:1788`), `healthStateLabel(check)` (`:2278`), `humanAction(active.status)`
   (`:2784`). Short today; the slot is not length-bounded.
7. **`DetailHeader.tsx:60`, `:64`** — title 1 line, subtitle 2. Screen-supplied copy,
   so bounded by the app rather than by data.
8. **`AdminScreen.tsx:1779`** — announcement title, 2 lines. Note the **body below it
   is safe**: `variant="body"` with no `numberOfLines` (`:1789-1791`), so it wraps.

### What is safe, and why

**No fixed-height container holds variable text.** Every literal `height:` found is a
decorative element or an empty spacer — icon wells (`EmptyState:80`, `ConfirmDialog:98`,
`ListRow:137`), status dots and bars (`Badge:84`, `FlexBar:145`, `GloveStatusStrip:186`),
the `Sheet` grabber (`:232`), the `TabBar` indicator (`:189`), and
`HistoryScreen`'s deliberate blank loading placeholder (`:383`). `minHeight` floors —
which are used at `TextboardScreen:419/479`, `RecognitionPanel:282`,
`DetectedTextCard:211`, `GloveConnectionBar:392/404` — grow with content and therefore
cannot clip.

**Variable text that wraps freely:** the user-facing announcement body
(`NoticesCard.tsx:205-206`), the account email in the account sheet
(`AccountSheet.tsx:942-944`), all error and notice banners (`AccountSheet.tsx:752`,
`:763`, `:800-807`, `:904`, via `bannerText { flex: 1 }`), and the Admin failure cards
(`AdminScreen.tsx:334-341`), where both the server's sentence and the advice are
uncapped. That last one matters: the error path added in this pass does not truncate
the explanation.

### Previously found and already fixed

Worth recording because they show the failure mode is real in this codebase, and that
it has been found before by this route rather than on a device:

| Site | What was wrong |
|---|---|
| `FlexBar.tsx:136` | Fixed width 52 with `numberOfLines={1}` truncated "Middle" → "Mid…" at 1.4×; now `label.minWidth: 52` (`:140`) and `values.minWidth: 92` (`:165`) |
| `LanguageSelector.tsx:94-104` | Native-name text clipped at 1.4×; row floor set to `MIN_TOUCH_TARGET` (`:151`) |
| `OledScreen.tsx:1484-1497` | Detail label and value overflowed at 360 dp + 1.4×; both given `flexShrink: 1` |
| `TextboardScreen.tsx:433-447` | Centred empty state clipped its own icon; changed to `justifyContent: 'flex-start'` |

The pattern is consistent: **everything in this table was found by reading layout code,
not by looking at a screen.** Which is the reason the remaining sites in the ranked list
above are flagged as risks rather than reported as defects — nobody has looked.

---

## 6. What cannot be verified without a device

Named explicitly, because the directive forbids claiming it and because a reader
should be able to see the boundary rather than infer it:

| Check | Why it needs hardware |
|---|---|
| Whether any text in §5 actually clips | Requires the screen, the font, the device's font scale and the real string lengths together |
| Overlapping content, spacing, alignment | Layout arithmetic cannot see overlap; only pixels can |
| Contrast ratios, in both themes | Requires compositing the real palette against the real background |
| Dynamic type at 1.4× | The cap is a code constant; its visual consequence is not |
| TalkBack traversal and labelling | Requires the accessibility layer |
| Reduced-motion behaviour | Not exercised anywhere by the code paths read |
| Touch-target accuracy | `hitSlop` is nominal; the true hit area is a platform behaviour |
| Android hardware back on every screen | Traced in code (§3), never pressed |
| iOS back behaviour | There is no iOS build here at all |
| **Admin screens on hardware** | **Never run on a device** — the entire §4 gap-closure surface is source-and-test only |
| Screenshots of each screen and state | **Not captured** — no device attached |

---

## 7. Proposed visual changes

**None to the Dashboard.** The directive forbids redesigning it, and nothing in this
source-level review justifies proposing a change to it — the Dashboard's absent
loading/error states (§2) are a design question, not a defect, and answering it needs
the screen in front of a person rather than a layout read.

The §5 clipping risks above are **not** proposed as changes. Each is a site where a cap
could bite; whether it does is unverified, and shortening or re-flowing text the user
needs to read is exactly the kind of change that should follow an observation, not
precede one. They are listed for review so that whoever next has a device knows where
to look first — `TranslatorPanel.tsx:199` and `VoicePanel.tsx:123` at the top.

**One change is proposed, and it is a test, not a visual change:** an assertion that
`hitSlop` is present on the four sub-44 dp controls (§3), so a refactor cannot drop it
silently. That is the only item here that can be settled without a device.

---

## 8. Findings, ranked

| # | Finding | Severity | Action |
|---|---|---|---|
| 1 | Admin screens have never run on a physical device | **High** | Owner: attach the handset; run the Admin pass |
| 2 | No screenshots of any screen or state exist for the Admin work | **High** | Owner: capture with a device attached |
| 3 | `TranslatorPanel.tsx:199` caps the translation at 3 lines, at the largest type size | Medium | Observe on device at 1.4× before changing |
| 4 | `VoicePanel.tsx:123` caps the spoken phrase at 1 line | Medium | Same |
| 5 | Four controls meet the touch floor only via `hitSlop`, with no test guarding it | Low | Add an assertion — cheap, no device needed |
| 6 | `iOS` has no back gesture, because navigation is hand-rolled | Low | Record as a known platform asymmetry |
| 7 | `DashboardScreen` has no loading or error state of its own | Low | Design question; needs the screen in hand |
| 8 | `ListRow` and `Badge` are shared slots with 1-line caps and unbounded content | Low | Watch as content grows |

---

## 9. Confirmation

| | |
|---|---|
| Screens inspected from source | **All 12 route-level screens + 5 ML areas + shared components** |
| Navigation traced | **Yes** — one navigator, 5 tabs, 5 detail keys, all reachable |
| Loading / empty / error / retry enumerated | **Yes** — §2, per screen |
| Touch targets measured from StyleSheets | **Yes** — §3 |
| Themes verified from code | **Yes** — §4 |
| Clipping risks identified from source | **Yes** — §5 |
| Files changed by this review | **None** — read-only inspection |
| Device attached | **No** — `adb devices -l` empty |
| Screenshots captured | **No** |
| Visual or device verification claimed | **No** |
| Dashboard redesigned | **No** |
| Dashboard changes proposed | **No** |
