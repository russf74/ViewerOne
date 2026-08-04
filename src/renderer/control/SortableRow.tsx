import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { SetlistItem } from '../../shared/types'
import { LED_PATTERNS } from '../../shared/ledPatterns'
import { isTimedSectionTitle, normalizeSongLength } from '../../shared/setlistTiming'

type Props = {
  item: SetlistItem
  isCurrent: boolean
  onChange: (patch: Partial<Pick<SetlistItem, 'title' | 'length' | 'year' | 'ledPattern'>>) => void
  onRemove: () => void
  /** Click row (not inputs/drag/select) to set as current for ESP preview — no MIDI. */
  onActivateRow?: () => void
}

export function SortableRow({ item, isCurrent, onChange, onRemove, onActivateRow }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id
  })

  const [titleDraft, setTitleDraft] = useState(item.title)
  const [lengthDraft, setLengthDraft] = useState(item.length)
  const [yearDraft, setYearDraft] = useState(item.year)
  const titleFocus = useRef(false)
  const lengthFocus = useRef(false)
  const yearFocus = useRef(false)

  useEffect(() => {
    setTitleDraft(item.title)
    setLengthDraft(item.length)
    setYearDraft(item.year)
  }, [item.id])

  useEffect(() => {
    if (!titleFocus.current) setTitleDraft(item.title)
  }, [item.title])

  useEffect(() => {
    if (!lengthFocus.current) setLengthDraft(item.length)
  }, [item.length])

  useEffect(() => {
    if (!yearFocus.current) setYearDraft(item.year)
  }, [item.year])

  const commitTitle = () => {
    titleFocus.current = false
    if (titleDraft !== item.title) onChange({ title: titleDraft })
  }

  const commitYear = () => {
    yearFocus.current = false
    if (yearDraft !== item.year) onChange({ year: yearDraft })
  }

  const commitLength = () => {
    lengthFocus.current = false
    const normalized = normalizeSongLength(lengthDraft)
    setLengthDraft(normalized)
    if (normalized !== item.length) onChange({ length: normalized })
  }

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 2 : undefined
  }

  const onRowClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('input, button, textarea, select, .drag-handle, .setlist-pattern-cell')) return
    onActivateRow?.()
  }

  const onTitleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }

  const onYearKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`setlist-row${item.arrangerIndex === null ? ' setlist-row--not-in-arranger' : ''}${isTimedSectionTitle(item.title) ? ' setlist-row--timed-section' : ''}${isCurrent ? ' current' : ''}${onActivateRow ? ' setlist-row-selectable' : ''}`}
      onClick={onRowClick}
      title={onActivateRow ? 'Click row (not fields) to preview on ESP — no MIDI to Cubase' : undefined}
    >
      <div className="drag-handle" {...attributes} {...listeners} title="Drag to reorder">
        ⋮⋮
      </div>
      <span
        className={`order-label${item.arrangerIndex === null ? ' order-label--not-in-arranger' : ''}`}
        title={
          item.arrangerIndex === null
            ? 'Not visited during the last successful Arranger scan'
            : `Arranger position #${item.arrangerIndex}`
        }
      >
        {item.arrangerIndex === null ? (
          <>
            <span aria-hidden>—</span>
            <span className="order-status">not in arranger</span>
          </>
        ) : (
          `#${item.arrangerIndex}`
        )}
      </span>
      <span className="prog-label" title="Cubase program number for this row (wire PC = this − 1). Songs use 1–119; 120–123 are prompt indicators and 125–127 are LED controls.">
        {item.program}
      </span>
      <input
        className="text-input"
        type="text"
        value={titleDraft}
        onChange={(e) => setTitleDraft(e.target.value)}
        onFocus={() => {
          titleFocus.current = true
        }}
        onBlur={commitTitle}
        onKeyDown={onTitleKeyDown}
        placeholder="Title"
      />
      <input
        className="text-input length-line"
        type="text"
        inputMode="numeric"
        value={lengthDraft}
        onChange={(e) => {
          const draft = e.target.value.replace(/[^\d:]/g, '')
          setLengthDraft(draft)
          const normalized = normalizeSongLength(draft)
          if ((draft === '' || normalized) && normalized !== item.length) {
            onChange({ length: normalized })
          }
        }}
        onFocus={() => {
          lengthFocus.current = true
        }}
        onBlur={commitLength}
        onKeyDown={onYearKeyDown}
        placeholder="MM:SS"
        aria-label={`Song length for ${item.title || `program ${item.program}`}`}
        title="Song length (mm:ss)"
      />
      <input
        className="text-input year-line"
        type="text"
        inputMode="numeric"
        maxLength={4}
        value={yearDraft}
        onChange={(e) => setYearDraft(e.target.value.replace(/\D/g, '').slice(0, 4))}
        onFocus={() => {
          yearFocus.current = true
        }}
        onBlur={commitYear}
        onKeyDown={onYearKeyDown}
        placeholder="Year"
      />
      <label className="setlist-pattern-cell" title="LED pattern for this song">
        <select
          value={item.ledPattern}
          onChange={(e) => onChange({ ledPattern: Number(e.target.value) })}
          aria-label="LED pattern"
        >
          {LED_PATTERNS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="danger" onClick={onRemove} title="Remove">
        ×
      </button>
    </div>
  )
}
