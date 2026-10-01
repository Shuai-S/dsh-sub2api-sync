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

.s2s-divider {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

.s2s-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex: none;
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
  display: flex;
  align-items: center;
  justify-content: space-between;
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

.s2s-reportLine {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  min-width: 0;
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

.s2s-fieldLabel {
  color: var(--dsw-alias-label-primary);
  flex: none;
}

.s2s-input {
  min-width: 0;
  flex: 1 1 220px;
}

/* Menu anchor wrapper: give the picker trigger the same field-column
   footprint as the sibling Input rows. */
.s2s-menuAnchor {
  display: flex;
  flex: 1 1 220px;
  min-width: 0;
}

.s2s-menuAnchor > * {
  width: 100%;
}

/* Select-style trigger (group picker): label left, chevron right. */
.s2s-selectTrigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
}

.s2s-selectChevron {
  flex: none;
  opacity: 0.55;
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
`

/** Inject the stylesheet once per document (idempotent across reloads). */
export function ensureCss(): void {
  if (document.querySelector('style[data-plugin="dsh-sub2api-sync"]') !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-sub2api-sync'
  style.textContent = CSS
  document.head.appendChild(style)
}
