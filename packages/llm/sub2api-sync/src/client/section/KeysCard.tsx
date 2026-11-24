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

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { KeysResponse, PanelKeyMeta } from '../../routes.ts'
import type { Sub2apiSyncConfig } from '../../config.ts'
import { protocolForPlatform } from '../../protocols.ts'
import { platformLabel } from '../../types.ts'
import { filterKeys, pageSlice } from '../keysFilter.ts'
import { pruneInvalidSelection, setField, useConfigForm } from '../useConfigForm.ts'
import type { GroupsView } from '../../routes.ts'
import type { NS } from '../locales.ts'
import { refreshStatus, useStatus } from '../status.ts'
import { syncProgressText } from '../progress.ts'
import type { PluginApi } from '../usePluginApi.ts'
import { GroupPicker } from './GroupPicker.tsx'

/** Rows per page. Paging is local: the list is a filtered snapshot. */
const PAGE_SIZE = 5
/** Keys per panel request while building the snapshot. */
const SNAPSHOT_PAGE_SIZE = 100
/** Page size retried when a panel refuses the large page. */
const SNAPSHOT_FALLBACK_PAGE_SIZE = 20
/** Hard stop for the snapshot walk (20 × 100 = 2000 keys). */
const SNAPSHOT_MAX_PAGES = 20
/** A burst of checkbox clicks coalesces into one settings write this long after
 * the last click (the click itself repaints optimistically, never waiting). */
const SELECTION_WRITE_DEBOUNCE_MS = 150

export interface KeysCardProps {
  api: PluginApi
  config: ConfigForm<Sub2apiSyncConfig>
  groups: GroupsView[]
  t: TranslateNS<typeof NS>
}

/** The keys list + create-key card. */
export function KeysCard({ api, config, groups, t }: KeysCardProps): ReactNode {
  const snapshot = useConfigForm(config)
  /** The account's keys, newest first — the whole snapshot, not one page. */
  const [keys, setKeys] = useState<PanelKeyMeta[]>([])
  /** Whether the snapshot walk stopped at SNAPSHOT_MAX_PAGES. */
  const [snapshotTruncated, setSnapshotTruncated] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [reloadTick, setReloadTick] = useState(0)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [groupId, setGroupId] = useState<number | ''>('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | undefined>(undefined)
  // The host publishes the running sync's phase (`/status` on a 1s cadence
  // while busy); the button tooltip and the hint line below it read from here.
  const status = useStatus()
  const progressText = syncing ? syncProgressText(t, status?.syncProgress) : undefined

  // A new term restarts at page 1 (the newest matches come first). Filtering
  // itself is local, so the debounce the server-side search needed is gone:
  // typing no longer issues a request at all. Enter still forces a snapshot
  // re-fetch, which is the manual refresh the removed button used to own.
  useEffect(() => { setPage(1) }, [search])

  // Snapshot walk: every key the account owns, so a term can match the group
  // name too (the panel's own `search` matches the key name/string only).
  // Pages are followed until the panel reports the last one; the walk stops at
  // SNAPSHOT_MAX_PAGES and the card says the list is partial. A monotonic
  // request id drops out-of-order walks (Enter while one is in flight).
  const requestSeqRef = useRef(0)
  useEffect(() => {
    const requestId = ++requestSeqRef.current
    setLoading(true)
    setListError(undefined)
    void (async () => {
      const collected: PanelKeyMeta[] = []
      let walked = 0
      let reportedPages = 1
      let pageSize = SNAPSHOT_PAGE_SIZE
      for (;;) {
        let response: KeysResponse
        try {
          response = await api.listKeys(walked + 1, pageSize)
        } catch (cause) {
          // An unfamiliar panel build may refuse the large page: fall back to
          // the conservative size once, then keep walking at that size.
          if (pageSize !== SNAPSHOT_PAGE_SIZE) throw cause
          pageSize = SNAPSHOT_FALLBACK_PAGE_SIZE
          continue
        }
        if (requestSeqRef.current !== requestId) return
        walked += 1
        reportedPages = Math.max(reportedPages, response.pages)
        collected.push(...response.keys)
        if (response.keys.length === 0 || walked >= reportedPages || walked >= SNAPSHOT_MAX_PAGES) break
      }
      setKeys(collected)
      setSnapshotTruncated(reportedPages > SNAPSHOT_MAX_PAGES)
    })()
      .catch((cause: unknown) => {
        if (requestSeqRef.current !== requestId) return
        setListError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (requestSeqRef.current === requestId) setLoading(false)
      })
  }, [api, reloadTick])

  /** The row's own group label, including the `#<id>` fallback the row shows
   * for groups this account cannot see — the term must match visible text. */
  const groupNameOf = (gid: number): string => groups.find((group) => group.id === gid)?.name ?? `#${gid}`

  const filtered = useMemo(
    () => filterKeys(keys, search, (key) => ({ name: key.name, groupName: groupNameOf(key.groupId) })),
    // groupNameOf closes over `groups`; the pair changes together.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys, search, groups],
  )
  const { rows: pageKeys, page: currentPage, pages } = pageSlice(filtered, page, PAGE_SIZE)

  const configSelection = snapshot.value?.selectedKeys ?? []
  /**
   * Optimistic overlay over the persisted selection. Every toggle is a
   * revision-fenced settings write through the host, so reading the checkbox
   * state straight from the config snapshot left the click visibly waiting for
   * that round trip. The click repaints from here immediately; the write
   * follows, coalesced so a burst of clicks costs one write.
   */
  const [selectionDraft, setSelectionDraft] = useState<number[] | null>(null)
  const selectedIds = selectionDraft ?? configSelection
  const persistTimer = useRef<number | null>(null)
  const pendingWrite = useRef<Promise<boolean> | null>(null)

  // The write caught up with the draft: hand the display back to the snapshot
  // (which is also how an external prune/drop becomes visible again).
  useEffect(() => {
    if (selectionDraft === null) return
    const same = selectionDraft.length === configSelection.length
      && selectionDraft.every((id, index) => id === configSelection[index])
    if (same) setSelectionDraft(null)
  }, [selectionDraft, configSelection])

  /** Write the selection now, cancelling a scheduled coalesced write. */
  const flushSelection = (list: number[]): Promise<boolean> => {
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current)
      persistTimer.current = null
    }
    const write = setField(config, 'selectedKeys', list)
      .then((accepted) => {
        // A refused write must not leave the checkbox showing a phantom state.
        if (!accepted) setSelectionDraft(null)
        return accepted
      })
      .catch(() => {
        setSelectionDraft(null)
        return false
      })
    pendingWrite.current = write
    return write
  }

  /** Apply a selection immediately, persist it after the burst settles. */
  const applySelection = (list: number[]): void => {
    setSelectionDraft(list)
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current)
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null
      void flushSelection(list)
    }, SELECTION_WRITE_DEBOUNCE_MS)
  }

  // An unmounted card must not fire a coalesced write afterwards.
  useEffect(() => () => {
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current)
  }, [])

  const toggle = (keyId: number, next: boolean): void => {
    const nextSet = new Set(selectedIds)
    if (next) nextSet.add(keyId)
    else nextSet.delete(keyId)
    applySelection([...nextSet].sort((a, b) => a - b))
  }

  const syncSelected = (): void => {
    if (selectedIds.length === 0) return
    const list = [...selectedIds]
    setSyncing(true)
    setFeedback(undefined)
    void (async () => {
      // The host syncs what the persisted config says, so a click made moments
      // ago has to land first (the card itself already shows it optimistically).
      if (persistTimer.current !== null) await flushSelection(list).catch(() => undefined)
      else if (pendingWrite.current !== null) await pendingWrite.current.catch(() => undefined)
      const report = await api.sync(list)
      const entries = report.report.entries
      const failed = entries.filter((entry) => entry.action === 'failed')
      const okCount = entries.length - failed.length
      // The reason is the whole point of the line: "1/6 成功" without WHY left
      // the first failure of this class undiagnosable.
      setFeedback(failed.length === 0
        ? { tone: 'ok', text: t('syncSelectedDone', { ok: okCount, total: entries.length }) }
        : { tone: 'error', text: t('syncPartial', { ok: okCount, total: entries.length, reason: failed[0]?.error ?? '' }) })
      // The run is over: release the button NOW. The bookkeeping that follows
      // (stale-selection prune, status refresh) cannot change what this card
      // shows, and holding the spinner on it made the sync look longer than it
      // was by one settings write + one status round trip.
      setSyncing(false)
      // Stale selections (ids the panel no longer serves) have no row to
      // uncheck — drop them from the selection automatically. Then republish
      // the status so the sync card's summary catches up.
      void pruneInvalidSelection(config, report.report)
        .then(() => refreshStatus())
        .catch(() => undefined)
    })()
      .catch((cause: unknown) => { setFeedback({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) }) })
      .finally(() => { setSyncing(false) })
  }

  /** Pick a group: the name field auto-fills with the group name unless typed. */
  const pickGroup = (gid: number): void => {
    setGroupId(gid)
    if (!nameTouched) setName(groupNameOf(gid))
  }

  const selectGroup = (group: GroupsView): void => { pickGroup(group.id) }

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
        const nextSet = new Set(selectedIds)
        nextSet.add(response.key.id)
        const list = [...nextSet].sort((a, b) => a - b)
        setSelectionDraft(list)
        await flushSelection(list)
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
      {/* No title row: the search field is this card's header. Its placeholder
          states the live scope ("搜索现有的 31 把 key…") and re-querying is what
          the field already does, so a separate label + count line would only
          repeat the placeholder. */}
      <div className="s2s-toolbar">
        <Input
          className="s2s-searchInput"
          type="text"
          value={search}
          aria-label={t('keysSearchLabel')}
          placeholder={keys.length > 0 ? t('keysSearchPlaceholderCount', { count: keys.length }) : t('keysSearchPlaceholder')}
          onChange={(event) => { setSearch(event.target.value) }}
          onKeyDown={(event) => {
            // Enter re-queries the current term (the manual refresh path the
            // removed button used to own); Escape clears the term.
            if (event.key === 'Enter') setReloadTick((tick) => tick + 1)
            if (event.key === 'Escape' && search.length > 0) setSearch('')
          }}
        />
        <Button
          variant="primary"
          disabled={syncing || selectedIds.length === 0}
          title={syncing ? progressText : undefined}
          onClick={syncSelected}
        >
          {/* The button keeps its own width while a run is in flight; the live
              phase rides next to it (where there is room) and in the tooltip. */}
          {syncing ? t('syncing') : t('syncSelected', { count: selectedIds.length })}
        </Button>
      </div>

      {feedback !== undefined && (
        <p className={`s2s-feedback ${feedback.tone === 'ok' ? 's2s-feedbackOk' : 's2s-feedbackError'}`}>{feedback.text}</p>
      )}
      {progressText !== undefined && <p className="s2s-feedback s2s-hint">{progressText}</p>}
      {listError !== undefined && <p className="s2s-feedback s2s-feedbackError">{listError}</p>}
      {snapshotTruncated && <p className="s2s-feedback s2s-hint">{t('keysSnapshotTruncated')}</p>}
      {!loading && filtered.length === 0 && listError === undefined && (
        <p className="s2s-feedback s2s-hint">{search.trim() !== '' ? t('keysSearchEmpty') : t('keysListEmpty')}</p>
      )}
      {loading && keys.length === 0 && <p className="s2s-feedback s2s-hint">{t('keysListLoading')}</p>}
      {pageKeys.length > 0 && (
        <div className="s2s-column">
          {pageKeys.map((key) => {
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
                  title={key.name}
                />
                <span className="s2s-tagCell" title={groupNameOf(key.groupId)}>
                  <Tag tone="neutral">
                    <span className="s2s-tagText">{groupNameOf(key.groupId)}</span>
                  </Tag>
                </span>
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
      {/* Footer line: the create action anchors the left edge and never
          disappears (an empty list still needs a way to create the first key);
          the pager rail beside it hides on a quiet single page but stays
          visible during a search so the result count stays readable at 1/1. */}
      <div className="s2s-pager">
        <Button variant="outline" onClick={() => { setCreating(true) }}>{t('createKey')}</Button>
        {filtered.length > 0 && (pages > 1 || search.trim() !== '') && (
          <div className="s2s-pagerActions">
            <Button variant="outline" disabled={loading || currentPage <= 1} onClick={() => { setPage(currentPage - 1) }}>
              {t('keysPagePrev')}
            </Button>
            <span className="s2s-pageStatus">{t('keysPageStatus', { page: currentPage, pages, total: filtered.length })}</span>
            <Button variant="outline" disabled={loading || currentPage >= pages} onClick={() => { setPage(currentPage + 1) }}>
              {t('keysPageNext')}
            </Button>
          </div>
        )}
      </div>

      <Modal open={creating} onClose={closeCreate} title={t('createKey')} closeLabel={t('close')} footer={createFooter}>
        <div className="s2s-column">
          <div className="s2s-inline">
            <span className="s2s-fieldLabel">{t('keyGroupLabel')}</span>
            <GroupPicker
              groups={groups}
              value={groupId}
              placeholder={t('keyGroupPlaceholder')}
              searchPlaceholder={t('keyGroupSearch')}
              emptyLabel={t('keyGroupSearchEmpty')}
              disabled={busy}
              onSelect={selectGroup}
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
