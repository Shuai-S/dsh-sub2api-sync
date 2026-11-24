/**
 * The plugin's one stylesheet, injected once as a `<style data-plugin>`
 * element. Values follow the ui-settings-account `AccountSection.module.css`
 * visual spec exactly (design note §4.4) — page root, cards, rows, identity
 * slots, dividers, and actions — so the card sits next to the official
 * Account section without visual drift. Class names carry the `s2s-` prefix
 * because the sheet is global, not module-scoped.
 *
 * @module sub2api-sync/client/styles
 */

const CSS = `
.s2s-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
  font-size: 13px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}

.s2s-card {
  display: flex;
  flex-direction: column;
  padding: 12px 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-settings-card-fill);
}

.s2s-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 40px;
  padding: 6px 0;
  box-sizing: border-box;
}

.s2s-identity {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  min-width: 0;
}

.s2s-avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-skeleton);
}

.s2s-avatar .s2s-favicon {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  object-fit: contain;
}

.s2s-actions .s2s-feedback {
  margin-right: 2px;
  white-space: nowrap;
}

.s2s-identityCopy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.s2s-name {
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.s2s-secondary {
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The keys card has no title row: its search field carries the header role
   (the placeholder states the live key count). Four controls in one title row
   used to overflow a settings dialog (~470px of usable width) and wrap the
   last button onto a second right-aligned line — the toolbar below keeps the
   one-row shape at every width. */
.s2s-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 10px;
}

/* Buttons keep their intrinsic width; only the search field stretches. */
.s2s-toolbar > button {
  flex: none;
}

.s2s-divider {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

/* flex: 1 1 auto is load-bearing: a shrink-to-fit (flex: none) WRAPPING flex
   container sizes itself by its largest item's contribution, not the sum of
   items, so an input+save pair inside sized .s2s-actions to the input alone
   and pushed the button onto a second right-aligned line (the stacked
   config-field rows). Filling the row keeps one line on desktop; the wrap
   below still degrades gracefully when the row itself runs out of space. */
.s2s-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex: 1 1 auto;
  min-width: 0;
}

/* The account-balance pill in the identity header's action row. */
.s2s-balance {
  flex: none;
  padding: 3px 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-secondary);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.s2s-warn {
  margin: 0;
  padding: 8px 12px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent);
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-state-warn-primary);
  background: var(--dsw-alias-state-warn-tertiary);
}

.s2s-feedback {
  margin: 0;
  padding: 2px 0 6px;
  overflow-wrap: anywhere;
}

.s2s-feedbackOk {
  color: var(--dsw-alias-state-success-primary);
}

.s2s-feedbackError {
  color: var(--dsw-alias-state-error-primary);
}

.s2s-column {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.s2s-hint {
  color: var(--dsw-alias-label-tertiary);
}

.s2s-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 40px;
  padding: 6px 0;
  box-sizing: border-box;
}

.s2s-keyRow {
  display: grid;
  /* Columns align across rows: name+checkbox / group / status / type. The
     last two tracks are fixed-width so the name column absorbs the slack and a
     long group tag cannot push the status/platform columns around. */
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) 5.5em 6.5em;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 4px 10px;
  box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  user-select: none;
}

.s2s-keyRow > :last-child {
  justify-self: end;
  text-align: right;
}

.s2s-keyRow:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.s2s-keyRow:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}

.s2s-keyRow[aria-pressed='true'] {
  border-color: var(--dsw-alias-state-business-primary);
}

/* The group tag keeps to its own track: a long group name clips with an
   ellipsis (the full name rides the wrapper's title) instead of running into
   the status column. */
.s2s-tagCell {
  display: flex;
  min-width: 0;
  overflow: hidden;
}

.s2s-tagCell > * {
  min-width: 0;
  max-width: 100%;
}

.s2s-tagText {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.s2s-reportLine {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  min-width: 0;
}

.s2s-reportRemove {
  margin-left: auto;
  flex: none;
  align-self: center;
}

.s2s-reportMark {
  flex: none;
  font-weight: 500;
}

.s2s-reportMark[data-mark='ok']::before {
  content: '\\2713';
  color: var(--dsw-alias-state-success-primary);
}

.s2s-reportMark[data-mark='fail']::before {
  content: '\\2717';
  color: var(--dsw-alias-state-error-primary);
}

.s2s-reportText {
  min-width: 0;
  overflow-wrap: anywhere;
}

.s2s-reportError {
  color: var(--dsw-alias-state-error-primary);
}

/* Failure reason riding after a route's tags — the merged list keeps the
   explanation on the row it belongs to instead of in a second block. */
.s2s-inlineError {
  margin-left: 8px;
  color: var(--dsw-alias-state-error-primary);
}

.s2s-fieldLabel {
  color: var(--dsw-alias-label-primary);
  flex: none;
}

.s2s-input {
  min-width: 0;
  flex: 1 1 220px;
}

/* Group picker (create-key dialog): the trigger takes the same field-column
   footprint as the sibling Input rows, painted like an input rather than a
   button so both rows read as one form. */
.s2s-groupPicker {
  display: flex;
  flex: 1 1 220px;
  min-width: 0;
}

.s2s-selectField {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  user-select: none;
}

.s2s-selectField:disabled {
  opacity: 0.55;
  cursor: default;
}

.s2s-selectField:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}

.s2s-selectPlaceholder {
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.s2s-selectValue {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.s2s-selectChevron {
  flex: none;
  opacity: 0.55;
  transition: transform var(--ds-transition-duration) var(--ds-ease-in-out);
}

.s2s-selectChevronOpen {
  transform: rotate(180deg);
}

/* The options panel: fixed-positioned from the trigger (escapes the modal
   card's overflow clip), width-matched to it, search pinned on top, options
   scrolling below. position: fixed is load-bearing: MenuSurface defaults to
   position: relative, and without this rule the panel becomes a flex item
   inside the form row while the viewport-coordinate top/left from
   useAnchoredPosition act as relative offsets — the panel displaces across
   the dialog and stays clipped by the card (the blank floating box bug). */
.s2s-groupPanel {
  position: fixed;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  z-index: 10;
  overflow: hidden;
  /* Elevation separates the panel from the dialog it floats over: without it
     the flat white surface reads as the card being stretched (the "overflows
     the dialog" report). */
  border: 0.5px solid var(--dsw-alias-border-l3);
  box-shadow: 0 16px 40px color-mix(in srgb, #000 18%, transparent), 0 2px 8px color-mix(in srgb, #000 8%, transparent);
}

.s2s-groupSearch {
  flex: none;
  padding: 8px 8px 6px;
}

.s2s-groupSearch > * {
  width: 100%;
  /* The Input primitive's wrapper is content-box: width:100% alone adds its
     16px padding and 1px border on top of the row and pokes 17px past the
     panel's right edge (clipped by the panel, so it reads as "the field is
     wider than the popup"). */
  box-sizing: border-box;
}

.s2s-groupList {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 8px 8px;
}

.s2s-groupEmpty {
  margin: 0;
  padding: 10px 4px;
  color: var(--dsw-alias-label-tertiary);
  text-align: center;
}

.s2s-groupOption {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 6px 10px;
  box-sizing: border-box;
  border: 0;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.s2s-groupOption[data-active='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
}

.s2s-groupOptionName {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.s2s-groupOptionCheck {
  flex: none;
  color: var(--dsw-alias-state-business-primary);
}


/* The keys-card search input: the elastic item of .s2s-toolbar. It takes the
   leftover width and shrinks first, so the row keeps one line as long as the
   buttons alone fit (the fixed 220px slot this replaces guaranteed a wrap). */
.s2s-searchInput {
  flex: 1 1 160px;
  min-width: 120px;
  width: auto;
}

/* The keys-card footer: the create action anchors the left edge and the pager
   rail stays right, so the card keeps one stable bottom line whether or not
   the pager is rendered (the create entry must survive an empty list). */
.s2s-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  min-height: 32px;
  padding-top: 2px;
}

.s2s-pagerActions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.s2s-pageStatus {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* U2 placements: the provider-card badge, the Models-page footer strip, and
   the Plugins-page activation steps. */
.s2s-badgeRow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 6px;
}

.s2s-badgeMeta {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.s2s-badgeHint {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.s2s-footerStrip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 32px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.s2s-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 22px;
}

/* Mobile (dsh-Go web island / narrow windows): stack the row layouts, keep
   interactive rows at Android's 44dp touch floor, and let the anchored group
   panel clear the soft keyboard. The desktop spec above is untouched — every
   rule here is scoped to the narrow viewport. */
@media (max-width: 640px) {
  .s2s-section {
    gap: 12px;
  }

  .s2s-row,
  .s2s-inline {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .s2s-actions {
    justify-content: flex-start;
  }

  .s2s-actions .s2s-feedback {
    white-space: normal;
  }

  .s2s-keyRow {
    grid-template-columns: minmax(0, 1fr);
    min-height: 44px;
    padding: 8px 10px;
  }

  .s2s-keyRow > :last-child {
    justify-self: start;
    text-align: left;
  }

  .s2s-selectField,
  .s2s-groupOption {
    min-height: 44px;
  }

  .s2s-input,
  .s2s-groupPicker {
    flex-basis: 100%;
  }

  .s2s-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .s2s-toolbar > button {
    width: 100%;
  }

  .s2s-searchInput {
    width: 100%;
    flex: 1 1 100%;
  }

  .s2s-pagerActions {
    justify-content: center;
  }

  .s2s-footerStrip {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }

  .s2s-reportRemove {
    margin-left: 0;
    align-self: flex-end;
  }

  /* Keyboard clearance: the fixed-position panel must not run under the
     soft keyboard; dvh tracks the visual viewport on Android WebViews. */
  .s2s-groupPanel {
    max-height: 60dvh;
  }
}

/* Notch and gesture-bar insets on standalone web islands. */
@supports (padding: max(0px)) {
  @media (max-width: 640px) {
    .s2s-section {
      padding-left: max(8px, env(safe-area-inset-left));
      padding-right: max(8px, env(safe-area-inset-right));
    }
  }
}
`

/**
 * Ensure this build's stylesheet is the one the document carries.
 *
 * Content-addressed rather than presence-checked: a plugin reload re-runs the
 * client module while the injected <style> element survives, so a mere
 * existence check kept serving the previous build's rules against the new DOM
 * — new class names arrive unstyled and old widths stick until a full page
 * reload. Replacing the text when it differs is idempotent for an unchanged
 * build and self-healing across a rebuild.
 */
export function ensureCss(): void {
  const existing = document.querySelector('style[data-plugin="dsh-sub2api-sync"]')
  if (existing !== null) {
    if (existing.textContent !== CSS) existing.textContent = CSS
    return
  }
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-sub2api-sync'
  style.textContent = CSS
  document.head.appendChild(style)
}
