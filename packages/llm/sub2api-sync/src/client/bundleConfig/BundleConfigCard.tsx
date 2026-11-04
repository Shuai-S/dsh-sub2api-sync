/**
 * The plugin-page configuration card (`plugins.bundle.config`, keyed by this
 * bundle's package name): the tuning fields — provider-name template, created
 * key quota/expiry, auto-sync interval, orphan-key revocation, metadata
 * enrichment, and the cross-device action escape hatch. Values read from the
 * plugin's own configuration form (the same `configForms` seam the settings
 * card uses) and write through field-level `form.set`/`unset` calls; the card
 * renders only on the bundle's own page (`view === 'page'`).
 *
 * The slot contract (dsh-client-ui-plugin-manager 0.2.0-rc.2) declares an
 * optional host-owned `ConfigPageForm`, but the detail page renders this slot
 * without one — its `formFor` only serves the row/item dialogs, so every card
 * keyed to this slot sees `form === undefined` and a blank section shows. The
 * card therefore writes through the plugin's own form, which shares the same
 * settings store; if a later host revision starts passing `form`, migrating
 * back to the contract path is a contained change.
 *
 * The slot contract rides the `@deepseek-ai/dsh-client-ui-plugin-manager`
 * client augmentation (pulled below). `protocolOverrides`/`compatTemplate`
 * stay YAML-only by design (§2: 一字段一写面).
 *
 * @module sub2api-sync/client/bundleConfig/BundleConfigCard
 */

import { useEffect, useState } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Sub2apiSyncConfig } from '../../config.ts'
import type { NS } from '../locales.ts'
import { setField, unsetField, useConfigForm, type ConfigPathOp } from '../useConfigForm.ts'

/** Business face the mount injects into the bundle config card. */
export interface BundleConfigInjected {
  config: ConfigForm<Sub2apiSyncConfig>
}

/** Composed card props: owner/key share + locale seat + the plugin's own config form. */
export type BundleConfigCardProps =
  PropsRuntime<'plugins.bundle.config'> & PropsLocale<typeof NS> & InjectFace<BundleConfigInjected>

/** `''` marks "unset the field"; `'invalid'` marks a draft the field rejects. */
type ParsedNumber = number | '' | 'invalid'

function parseNumber(text: string): ParsedNumber {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ''
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : 'invalid'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Feedback = { tone: 'ok' | 'error'; text: string } | undefined

/** @param props - owner/locale shares plus the injected config form. @returns the fields, or null off-page. */
export function BundleConfigCard({ view, t, config }: BundleConfigCardProps) {
  if (view !== 'page') return null
  return <BundleConfigFields config={config} t={t} />
}

function BundleConfigFields({ config, t }: { config: ConfigForm<Sub2apiSyncConfig>; t: PropsLocale<typeof NS>['t'] }) {
  const snapshot = useConfigForm(config)
  const values = (snapshot.value ?? {}) as Partial<Sub2apiSyncConfig>
  const writable = snapshot.writable
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(undefined)

  // Field-level writes over the plugin's own config form. Every op this card
  // produces addresses a top-level field, so the path-op list maps 1:1 onto
  // sequential form.set/unset calls; the first refusal aborts the batch.
  const run = (ops: readonly ConfigPathOp[]): void => {
    setBusy(true)
    setFeedback(undefined)
    const apply = async (): Promise<boolean> => {
      for (const op of ops) {
        const field = op.path[0]
        if (field === undefined || field === '') return false
        const accepted = op.op === 'set'
          ? await setField(config, field, op.value)
          : await unsetField(config, field)
        if (!accepted) return false
      }
      return true
    }
    apply()
      .then((accepted) => {
        setFeedback(accepted ? { tone: 'ok', text: t('savedNotice') } : { tone: 'error', text: t('writeRefused') })
      })
      .catch((cause) => { setFeedback({ tone: 'error', text: t('actionFailedLabel', { message: messageOf(cause) }) }) })
      .finally(() => { setBusy(false) })
  }

  // Text drafts sync from the mirror whenever the stored value moves.
  const [templateDraft, setTemplateDraft] = useState(values.providerNameTemplate ?? '')
  useEffect(() => { setTemplateDraft(values.providerNameTemplate ?? '') }, [values.providerNameTemplate])
  const [quotaDraft, setQuotaDraft] = useState(values.keyQuota === undefined ? '' : String(values.keyQuota))
  useEffect(() => { setQuotaDraft(values.keyQuota === undefined ? '' : String(values.keyQuota)) }, [values.keyQuota])
  const [expiryDraft, setExpiryDraft] = useState(values.keyExpiresInDays === undefined ? '' : String(values.keyExpiresInDays))
  useEffect(() => { setExpiryDraft(values.keyExpiresInDays === undefined ? '' : String(values.keyExpiresInDays)) }, [values.keyExpiresInDays])
  const [intervalDraft, setIntervalDraft] = useState(values.syncIntervalMs === undefined ? '' : String(values.syncIntervalMs))
  useEffect(() => { setIntervalDraft(values.syncIntervalMs === undefined ? '' : String(values.syncIntervalMs)) }, [values.syncIntervalMs])

  const templateInvalid = !(templateDraft.includes('{keyName}'))
  const quotaParsed = parseNumber(quotaDraft)
  const quotaInvalid = quotaParsed === 'invalid' || (quotaParsed !== '' && quotaParsed < 0)
  const expiryParsed = parseNumber(expiryDraft)
  const expiryInvalid = expiryParsed === 'invalid' || (expiryParsed !== '' && (!Number.isInteger(expiryParsed) || expiryParsed < 1))
  const intervalParsed = parseNumber(intervalDraft)
  const intervalInvalid = intervalParsed === 'invalid' || (intervalParsed !== '' && (!Number.isInteger(intervalParsed) || intervalParsed < 60000))

  const numberOp = (field: string, parsed: ParsedNumber): ConfigPathOp =>
    parsed === ''
      ? { op: 'unset', path: [field] }
      : { op: 'set', path: [field], value: parsed }

  return (
    <div className="s2s-section">
      <section className="s2s-card">
        <TextFieldRow
          id="sub2api-sync-provider-name-template"
          label={t('bundleTemplateLabel')}
          value={templateDraft}
          hint={t('bundleTemplateHint')}
          invalid={templateInvalid}
          invalidHint={t('bundleTemplateInvalid')}
          disabled={!writable || busy}
          saveDisabled={templateDraft.trim() === (values.providerNameTemplate ?? '')}
          onChange={setTemplateDraft}
          saveLabel={t('save')}
          onSave={() => { run([{ op: 'set', path: ['providerNameTemplate'], value: templateDraft.trim() }]) }}
        />
        <div className="s2s-divider" />
        <TextFieldRow
          id="sub2api-sync-key-quota"
          label={t('bundleKeyQuotaLabel')}
          value={quotaDraft}
          hint={t('bundleKeyQuotaHint')}
          invalid={quotaInvalid}
          invalidHint={t('bundleNumberInvalid')}
          disabled={!writable || busy}
          saveDisabled={quotaDraft.trim() === (values.keyQuota === undefined ? '' : String(values.keyQuota))}
          onChange={setQuotaDraft}
          saveLabel={t('save')}
          onSave={() => { run([numberOp('keyQuota', quotaParsed)]) }}
        />
        <div className="s2s-divider" />
        <TextFieldRow
          id="sub2api-sync-key-expiry"
          label={t('bundleKeyExpiresLabel')}
          value={expiryDraft}
          hint={t('bundleKeyExpiresHint')}
          invalid={expiryInvalid}
          invalidHint={t('bundleNumberInvalid')}
          disabled={!writable || busy}
          saveDisabled={expiryDraft.trim() === (values.keyExpiresInDays === undefined ? '' : String(values.keyExpiresInDays))}
          onChange={setExpiryDraft}
          saveLabel={t('save')}
          onSave={() => { run([numberOp('keyExpiresInDays', expiryParsed)]) }}
        />
        <div className="s2s-divider" />
        <TextFieldRow
          id="sub2api-sync-sync-interval"
          label={t('bundleIntervalLabel')}
          value={intervalDraft}
          hint={t('bundleIntervalHint')}
          invalid={intervalInvalid}
          invalidHint={t('bundleIntervalInvalid')}
          disabled={!writable || busy}
          saveDisabled={intervalDraft.trim() === (values.syncIntervalMs === undefined ? '' : String(values.syncIntervalMs))}
          onChange={setIntervalDraft}
          saveLabel={t('save')}
          onSave={() => { run([numberOp('syncIntervalMs', intervalParsed)]) }}
        />
        <div className="s2s-divider" />
        <SwitchRow
          label={t('bundleDeleteOrphanLabel')}
          hint={t('bundleDeleteOrphanHint')}
          checked={values.deleteOrphanKeys === true}
          disabled={!writable || busy}
          onChange={(next) => { run([{ op: 'set', path: ['deleteOrphanKeys'], value: next }]) }}
        />
        <SwitchRow
          label={t('bundleEnrichLabel')}
          hint={t('bundleEnrichHint')}
          checked={values.enrichModelMeta !== false}
          disabled={!writable || busy}
          onChange={(next) => { run([{ op: 'set', path: ['enrichModelMeta'], value: next }]) }}
        />
        <SwitchRow
          label={t('bundleAllowRemoteLabel')}
          checked={values.allowRemoteActions === true}
          disabled={!writable || busy}
          onChange={(next) => { run([{ op: 'set', path: ['allowRemoteActions'], value: next }]) }}
        />
        <p className="s2s-feedback s2s-feedbackError">{t('bundleAllowRemoteWarning')}</p>
        {feedback !== undefined && (
          <p className={`s2s-feedback ${feedback.tone === 'ok' ? 's2s-feedbackOk' : 's2s-feedbackError'}`}>{feedback.text}</p>
        )}
        <span className="s2s-hint">{t('bundleAdvancedHint')}</span>
      </section>
    </div>
  )
}

/** One labeled text field with its own save control. */
function TextFieldRow(props: {
  id: string
  label: string
  value: string
  hint: string
  invalid: boolean
  invalidHint: string
  disabled: boolean
  saveDisabled: boolean
  onChange(text: string): void
  saveLabel: string
  onSave(): void
}) {
  return (
    <div className="s2s-column">
      <div className="s2s-row">
        <label className="s2s-fieldLabel" htmlFor={props.id}>{props.label}</label>
        <div className="s2s-actions">
          <Input
            id={props.id}
            className="s2s-input"
            type="text"
            value={props.value}
            disabled={props.disabled}
            aria-invalid={props.invalid}
            onChange={(event) => { props.onChange(event.target.value) }}
          />
          <Button variant="primary" disabled={props.disabled || props.saveDisabled || props.invalid} onClick={props.onSave}>
            {props.saveLabel}
          </Button>
        </div>
      </div>
      {props.invalid
        ? <span className="s2s-feedback s2s-feedbackError">{props.invalidHint}</span>
        : <span className="s2s-hint">{props.hint}</span>}
    </div>
  )
}

/** One labeled switch row with its hint. */
function SwitchRow(props: {
  label: string
  hint?: string
  checked: boolean
  disabled: boolean
  onChange(next: boolean): void
}) {
  return (
    <div className="s2s-column">
      <div className="s2s-row">
        <span className="s2s-fieldLabel">{props.label}</span>
        <Switch checked={props.checked} disabled={props.disabled} label={props.label} onChange={props.onChange} />
      </div>
      {props.hint !== undefined && <span className="s2s-hint">{props.hint}</span>}
    </div>
  )
}
