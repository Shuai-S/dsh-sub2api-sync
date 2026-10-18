/**
 * The keys card (rev.6.1): the instance's relay keys listed newest-first,
 * searched server-side (the panel's `search` filter, debounced client-side)
 * and paged natively — 上一页/下一页 walk `pages` as the panel reports it.
 * The top-right 创建 key action opens a modal (sign-in-dialog pattern):
 * pick a group from all groups, name defaults to the group name, creation
 * checks the new key into `selectedKeys` (the sync selection is the config
 * field, not a per-group pin). Each listed row's checkbox drives the same
 * selection.
 *
 * @module sub2api-sync/client/section/KeysCard
 */

import { useEffect, useRef, useState } from 'react'
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
const SEARCH_DEBOUNCE_MS = 300

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
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [reloadTick, setReloadTick] = useState(0)
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

  // Debounce typing into the applied search term; a changed term restarts
  // at page 1 (the newest matches come first).
  const appliedQueryRef = useRef(query)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = search.trim()
      if (appliedQueryRef.current !== next) {
        appliedQueryRef.current = next
        setQuery(next)
        setPage(1)
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search])

  // One fetch per (page, query, reload); a monotonic request id drops
  // out-of-order answers so fast typing cannot paint a stale page.
  const requestSeqRef = useRef(0)
  useEffect(() => {
    const requestId = ++requestSeqRef.current
    setLoading(true)
    setListError(undefined)
    api.listKeys(page, PAGE_SIZE, query === '' ? undefined : query)
      .then((response) => {
        if (requestSeqRef.current !== requestId) return
        setKeys(response.keys)
        setPages(response.pages)
        setTotal(response.total)
        // A narrowed search can shrink `pages` under the current page —
        // clamp instead of showing the panel's empty out-of-range page.
        if (response.pages > 0 && page > response.pages) setPage(response.pages)
      })
      .catch((cause: unknown) => {
        if (requestSeqRef.current !== requestId) return
        setListError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (requestSeqRef.current === requestId) setLoading(false)
      })
  }, [api, page, query, reloadTick])

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
        // New keys sort newest-first: land on page 1 (keeping the search)
        // and refetch.
        setPage(1)
        setReloadTick((tick) => tick + 1)
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
          <Input
            className="s2s-searchInput"
            type="text"
            value={search}
            placeholder={t('keysSearchPlaceholder')}
            onChange={(event) => { setSearch(event.target.value) }}
          />
          <Button variant="outline" onClick={() => { setReloadTick((tick) => tick + 1) }}>{t('groupsRefresh')}</Button>
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
      {!loading && keys.length === 0 && listError === undefined && (
        <p className="s2s-feedback s2s-hint">{query !== '' ? t('keysSearchEmpty') : t('keysListEmpty')}</p>
      )}
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
      {/* The pager hides on a quiet single page, but stays visible during a
          search so the result count stays readable even at 1/1. */}
      {keys.length > 0 && (pages > 1 || query !== '') && (
        <div className="s2s-pager">
          <Button variant="outline" disabled={loading || page <= 1} onClick={() => { setPage(page - 1) }}>
            {t('keysPagePrev')}
          </Button>
          <span className="s2s-pageStatus">{t('keysPageStatus', { page, pages, total })}</span>
          <Button variant="outline" disabled={loading || page >= pages} onClick={() => { setPage(page + 1) }}>
            {t('keysPageNext')}
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
