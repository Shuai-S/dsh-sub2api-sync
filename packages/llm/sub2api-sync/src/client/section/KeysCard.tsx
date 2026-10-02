/**
 * The keys card (rev.5 key-selection redesign): the instance's relay keys
 * listed newest-first, paged by the panel natively — the card loads the
 * first 5 and appends more with a 加载更多 button while `page < pages`.
 * The top-right 创建 key action opens a modal (sign-in-dialog pattern):
 * pick a group from all groups, name defaults to the group name, creation
 * binds the new key to that group (`groups.<id>.keyId`). Each listed row
 * binds/unbinds to its own group.
 *
 * @module sub2api-sync/client/section/KeysCard
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox, IconChevronDownOutlineRegular, Input, Menu, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PanelKeyMeta } from '../../routes.ts'
import type { Sub2apiSyncConfig } from '../../config.ts'
import { protocolForPlatform } from '../../protocols.ts'
import { platformLabel } from '../../types.ts'
import { pruneInvalidSelection, setField, useConfigForm } from '../useConfigForm.ts'
import type { GroupsView } from '../../routes.ts'
import type { NS } from '../locales.ts'
import { refreshStatus } from '../status.ts'
import type { PluginApi } from '../usePluginApi.ts'

const PAGE_SIZE = 5

export interface KeysCardProps {
  api: PluginApi
  config: ConfigForm<Sub2apiSyncConfig>
  groups: GroupsView[]
  t: TranslateNS<typeof NS>
}

/** The keys list + create-key card. */
export function KeysCard({ api, config, groups, t }: KeysCardProps): ReactNode {
  const snapshot = useConfigForm(config)
  const [keys, setKeys] = useState<PanelKeyMeta[]>([])
  const [page, setPage] = useState(0)
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [groupMenuOpen, setGroupMenuOpen] = useState(false)
  const [groupId, setGroupId] = useState<number | ''>('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | undefined>(undefined)

  // Append one page; page 0 means "not loaded yet".
  const loadPage = (next: number): void => {
    setLoading(true)
    setListError(undefined)
    api.listKeys(next, PAGE_SIZE)
      .then((response) => {
        setKeys((previous) => (next === 1 ? response.keys : [...previous, ...response.keys]))
        setPages(response.pages)
        setTotal(response.total)
        setPage(next)
      })
      .catch((cause: unknown) => { setListError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setLoading(false) })
  }

  useEffect(() => { loadPage(1) }, [api])

  const selectedIds = snapshot.value?.selectedKeys ?? []

  const toggle = (keyId: number, next: boolean): void => {
    const nextSet = new Set(selectedIds)
    if (next) nextSet.add(keyId)
    else nextSet.delete(keyId)
    void setField(config, 'selectedKeys', [...nextSet].sort((a, b) => a - b))
  }

  const syncSelected = (): void => {
    if (selectedIds.length === 0) return
    setSyncing(true)
    setFeedback(undefined)
    api.sync([...selectedIds])
      .then(async (report) => {
        const okCount = report.report.entries.filter((entry) => entry.action !== 'failed').length
        setFeedback({ tone: okCount === report.report.entries.length ? 'ok' : 'error', text: t('syncSelectedDone', { ok: okCount, total: report.report.entries.length }) })
        // Stale selections (ids the panel no longer serves) have no row to
        // uncheck — drop them from the selection automatically.
        await pruneInvalidSelection(config, report.report)
        await refreshStatus()
      })
      .catch((cause: unknown) => { setFeedback({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) }) })
      .finally(() => { setSyncing(false) })
  }

  const groupNameOf = (gid: number): string => groups.find((group) => group.id === gid)?.name ?? `#${gid}`

  /** Pick a group: the name field auto-fills with the group name unless typed. */
  const pickGroup = (gid: number): void => {
    setGroupId(gid)
    if (!nameTouched) setName(groupNameOf(gid))
  }

  const closeCreate = (): void => {
    setCreating(false)
    setGroupId('')
    setName('')
    setNameTouched(false)
  }

  const create = (): void => {
    if (groupId === '') return
    const finalName = (nameTouched ? name.trim() : '') || groupNameOf(groupId)
    setBusy(true)
    setFeedback(undefined)
    api.createKey({ groupId, name: finalName })
      .then(async (response) => {
        const nextSet = new Set(snapshot.value?.selectedKeys ?? [])
        nextSet.add(response.key.id)
        await setField(config, 'selectedKeys', [...nextSet].sort((a, b) => a - b))
        setFeedback({ tone: 'ok', text: t('keyCreated', { name: response.key.name }) })
        closeCreate()
        loadPage(1)
      })
      .catch((cause: unknown) => { setFeedback({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) }) })
      .finally(() => { setBusy(false) })
  }

  const createFooter = (
    <div className="s2s-actions">
      <Button variant="ghost" disabled={busy} onClick={closeCreate}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy || groupId === ''} onClick={create}>{t('createKey')}</Button>
    </div>
  )

  return (
    <section className="s2s-card">
      <div className="s2s-row">
        <span className="s2s-name">{t('keysTitle')}</span>
        <div className="s2s-actions">
          <Button variant="outline" onClick={() => { loadPage(1) }}>{t('groupsRefresh')}</Button>
          <Button
            variant="primary"
            disabled={syncing || selectedIds.length === 0}
            onClick={syncSelected}
          >
            {syncing ? t('syncing') : t('syncSelected', { count: selectedIds.length })}
          </Button>
          <Button variant="primary" onClick={() => { setCreating(true) }}>{t('createKey')}</Button>
        </div>
      </div>

      {feedback !== undefined && (
        <p className={`s2s-feedback ${feedback.tone === 'ok' ? 's2s-feedbackOk' : 's2s-feedbackError'}`}>{feedback.text}</p>
      )}
      {listError !== undefined && <p className="s2s-feedback s2s-feedbackError">{listError}</p>}
      {!loading && keys.length === 0 && listError === undefined && <p className="s2s-feedback s2s-hint">{t('keysListEmpty')}</p>}
      {loading && keys.length === 0 && <p className="s2s-feedback s2s-hint">{t('keysListLoading')}</p>}
      {keys.length > 0 && (
        <div className="s2s-column">
          {keys.map((key) => {
            // The group's type drives the wire-protocol mapping at sync
            // (anthropic → anthropic-messages, OpenAI family →
            // openai-responses, the rest → openai-completions); the row
            // surfaces it so the mapping is visible before syncing.
            const platform = groups.find((group) => group.id === key.groupId)?.platform
            const protocol = platform === undefined ? undefined : protocolForPlatform(platform)
            return (
              <div
                key={key.id}
                className="s2s-keyRow"
                onClick={(event) => {
                  // The checkbox label owns clicks on itself (its native
                  // change event fires there); any other click in the row
                  // toggles the selection once.
                  if ((event.target as HTMLElement).closest('label') !== null) return
                  toggle(key.id, !selectedIds.includes(key.id))
                }}
              >
                <Checkbox
                  checked={selectedIds.includes(key.id)}
                  onChange={(next) => { toggle(key.id, next) }}
                  label={key.name}
                />
                <Tag tone="neutral">{groupNameOf(key.groupId)}</Tag>
                {key.status !== undefined ? <span className="s2s-badgeHint">{key.status}</span> : null}
                <span
                  className="s2s-badgeHint"
                  title={platform === undefined ? undefined : t('groupTypeTitle', { type: platformLabel(platform), protocol: protocol ?? '—' })}
                >
                  {platform === undefined ? '—' : platformLabel(platform)}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {keys.length > 0 && page < pages && (
        <div className="s2s-actions">
          <Button variant="outline" disabled={loading} onClick={() => { loadPage(page + 1) }}>
            {t('keysLoadMore', { count: Math.max(0, Math.min(PAGE_SIZE, total - keys.length)) })}
          </Button>
        </div>
      )}

      <Modal open={creating} onClose={closeCreate} title={t('createKey')} closeLabel={t('close')} footer={createFooter}>
        <div className="s2s-column">
          <div className="s2s-inline">
            <span className="s2s-fieldLabel">{t('keyGroupLabel')}</span>
            <Menu
              open={groupMenuOpen}
              anchor={(
                <span className="s2s-menuAnchor">
                  <Button
                    variant="outline"
                    onClick={() => { setGroupMenuOpen(true) }}
                  >
                    <span className="s2s-selectTrigger">
                      <span>{groupId === '' ? t('keyGroupPlaceholder') : groupNameOf(groupId)}</span>
                      <IconChevronDownOutlineRegular size={14} className="s2s-selectChevron" />
                    </span>
                  </Button>
                </span>
              )}
              items={groups.map((group) => ({ id: String(group.id), label: group.name }))}
              selectedId={groupId === '' ? undefined : String(groupId)}
              onSelect={(id) => { pickGroup(Number(id)); setGroupMenuOpen(false) }}
              onClose={() => { setGroupMenuOpen(false) }}
            />
          </div>
          <div className="s2s-inline">
            <span className="s2s-fieldLabel">{t('keyNameLabel')}</span>
            <Input
              className="s2s-input"
              type="text"
              value={nameTouched ? name : (groupId === '' ? '' : groupNameOf(groupId))}
              placeholder={t('keyNameHint')}
              disabled={busy || groupId === ''}
              onChange={(event) => { setName(event.target.value); setNameTouched(true) }}
            />
          </div>
        </div>
      </Modal>
    </section>
  )
}
