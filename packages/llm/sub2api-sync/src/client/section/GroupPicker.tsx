/**
 * The create-key dialog's group picker: a select-style trigger with a
 * searchable, scrollable options panel.
 *
 * Why not the generic `Menu` primitive: it has no type-to-search, its list
 * width follows the content instead of the field, and inside the modal card
 * (`overflow: hidden`) a long list is clipped past the card edge with no
 * scrollbar. This picker renders the panel through `MenuSurface` with
 * `position: fixed` (fixed elements escape the card's clip), sizes it to the
 * trigger's exact width, clamps its height to the viewport
 * (`useAnchoredMaxHeight`), and filters as you type — the search field keeps
 * focus so arrows/Enter/Escape drive the list.
 *
 * @module sub2api-sync/client/section/GroupPicker
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular,
  Input,
  MenuSurface,
  useAnchoredMaxHeight,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GroupsView } from '../../routes.ts'

/** Design cap for the panel; the viewport clamp never exceeds it. */
const PANEL_MAX_HEIGHT = 280
/** Distance between the trigger's bottom edge and the panel. */
const PANEL_GAP = 6

export interface GroupPickerProps {
  groups: GroupsView[]
  /** Selected group id; `''` = nothing picked yet. */
  value: number | ''
  placeholder: string
  searchPlaceholder: string
  emptyLabel: string
  disabled?: boolean
  onSelect(group: GroupsView): void
}

/** The group field: trigger in the form row, options panel portaled via
 * fixed positioning so the modal card's clip cannot cut it off. */
export function GroupPicker({ groups, value, placeholder, searchPlaceholder, emptyLabel, disabled = false, onSelect }: GroupPickerProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [triggerWidth, setTriggerWidth] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selected = value === '' ? undefined : groups.find((group) => group.id === value)
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle === '') return groups
    return groups.filter((group) => group.name.toLowerCase().includes(needle))
  }, [groups, filter])

  const position = useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    panelRef,
    side: 'bottom',
    align: 'start',
    gap: PANEL_GAP,
    margin: 24,
  })
  // Re-fit whenever the filter changes the list's content height.
  const maxHeight = useAnchoredMaxHeight(panelRef, PANEL_MAX_HEIGHT, open ? filtered.length : 0)
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

  // Open: reset the filter/walk, measure the trigger so the panel matches its
  // width exactly, and focus the search field after the panel mounts.
  useEffect(() => {
    if (!open) return
    setFilter('')
    setActiveIndex(0)
    setTriggerWidth(triggerRef.current?.getBoundingClientRect().width ?? 0)
    const timer = window.setTimeout(() => { panelRef.current?.querySelector('input')?.focus() }, 0)
    return () => window.clearTimeout(timer)
  }, [open])

  // Keep the measured width in sync while open (window resizes).
  useEffect(() => {
    if (!open) return
    const onResize = (): void => { setTriggerWidth(triggerRef.current?.getBoundingClientRect().width ?? 0) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  // Keep the walked row visible inside the scrollable list.
  useEffect(() => {
    const list = listRef.current
    if (list === null) return
    list.querySelector("[data-active='true']")?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, filter])

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const pick = (group: GroupsView): void => {
    onSelect(group)
    close()
  }

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Escape') {
      // The picker owns Escape while open — stop it here or the dialog
      // underneath closes too.
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (filtered.length > 0) setActiveIndex((index) => Math.min(index + 1, filtered.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const group = filtered[activeIndex]
      if (group !== undefined) pick(group)
    }
  }

  return (
    <div className="s2s-groupPicker" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="s2s-selectField"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { setOpen((next) => !next) }}
      >
        <span className={selected === undefined ? 's2s-selectPlaceholder' : 's2s-selectValue'}>
          {selected === undefined ? placeholder : selected.name}
        </span>
        <IconChevronDownOutlineRegular size={14} className={`s2s-selectChevron${open ? ' s2s-selectChevronOpen' : ''}`} />
      </button>
      {open && (
        <MenuSurface
          ref={panelRef}
          className="s2s-groupPanel"
          role="listbox"
          style={position === null
            ? { visibility: 'hidden' }
            : {
                ...position,
                ...(triggerWidth > 0 ? { width: `${triggerWidth}px` } : {}),
                maxHeight: `${maxHeight}px`,
              }}
          onKeyDown={onKeyDown}
        >
          <div className="s2s-groupSearch">
            <Input
              type="text"
              value={filter}
              placeholder={searchPlaceholder}
              onChange={(event) => { setFilter(event.target.value); setActiveIndex(0) }}
            />
          </div>
          <div className="s2s-groupList" ref={listRef}>
            {filtered.length === 0 && <p className="s2s-groupEmpty">{emptyLabel}</p>}
            {filtered.map((group, index) => (
              <button
                key={group.id}
                type="button"
                role="option"
                aria-selected={group.id === value}
                data-active={index === activeIndex || undefined}
                className="s2s-groupOption"
                onMouseEnter={() => { setActiveIndex(index) }}
                onClick={() => { pick(group) }}
              >
                <span className="s2s-groupOptionName">{group.name}</span>
                {group.id === value && <span className="s2s-groupOptionCheck" aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>
        </MenuSurface>
      )}
    </div>
  )
}
