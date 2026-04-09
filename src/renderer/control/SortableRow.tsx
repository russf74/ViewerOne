import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { SetlistItem } from '../../shared/types'

type Props = {
  item: SetlistItem
  isCurrent: boolean
  onChange: (patch: Pick<SetlistItem, 'title' | 'chords' | 'live'>) => void
  onRemove: () => void
  /** Click row (not inputs/drag/live) to set as current for ESP preview — no MIDI. */
  onActivateRow?: () => void
}

export function SortableRow({ item, isCurrent, onChange, onRemove, onActivateRow }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id
  })

  const [titleDraft, setTitleDraft] = useState(item.title)
  const [chordsDraft, setChordsDraft] = useState(item.chords)
  const titleFocus = useRef(false)
  const chordsFocus = useRef(false)

  useEffect(() => {
    setTitleDraft(item.title)
    setChordsDraft(item.chords)
  }, [item.id])

  useEffect(() => {
    if (!titleFocus.current) setTitleDraft(item.title)
  }, [item.title])

  useEffect(() => {
    if (!chordsFocus.current) setChordsDraft(item.chords)
  }, [item.chords])

  const commitTitle = () => {
    titleFocus.current = false
    if (titleDraft !== item.title) onChange({ title: titleDraft })
  }

  const commitChords = () => {
    chordsFocus.current = false
    if (chordsDraft !== item.chords) onChange({ chords: chordsDraft })
  }

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 2 : undefined
  }

  const onRowClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('input, button, textarea, .drag-handle, .setlist-live-cell')) return
    onActivateRow?.()
  }

  const onTitleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }

  const onChordsKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`setlist-row${isCurrent ? ' current' : ''}${onActivateRow ? ' setlist-row-selectable' : ''}`}
      onClick={onRowClick}
      title={onActivateRow ? 'Click row (not fields) to preview on ESP — no MIDI to Cubase' : undefined}
    >
      <div className="drag-handle" {...attributes} {...listeners} title="Drag to reorder">
        ⋮⋮
      </div>
      <span className="prog-label" title="Cubase program number for this row (matches standard 0–127 MIDI PC + 1).">
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
        className="text-input chord-line"
        type="text"
        value={chordsDraft}
        onChange={(e) => setChordsDraft(e.target.value)}
        onFocus={() => {
          chordsFocus.current = true
        }}
        onBlur={commitChords}
        onKeyDown={onChordsKeyDown}
        placeholder="Chords (N = new line on ESP)"
      />
      <label className="setlist-live-cell" title="Live: chord display is green; off = red">
        <input
          type="checkbox"
          checked={item.live}
          onChange={(e) => onChange({ live: e.target.checked })}
        />
      </label>
      <button type="button" className="danger" onClick={onRemove} title="Remove">
        ×
      </button>
    </div>
  )
}
