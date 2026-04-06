import type { CSSProperties } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { SetlistItem } from '../../shared/types'

type Props = {
  item: SetlistItem
  isCurrent: boolean
  onChange: (patch: Pick<SetlistItem, 'title' | 'chords' | 'live'>) => void
  onRemove: () => void
}

export function SortableRow({ item, isCurrent, onChange, onRemove }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id
  })

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 2 : undefined
  }

  return (
    <div ref={setNodeRef} style={style} className={`setlist-row${isCurrent ? ' current' : ''}`}>
      <div className="drag-handle" {...attributes} {...listeners} title="Drag to reorder">
        ⋮⋮
      </div>
      <span className="prog-label" title="Cubase program number for this row (matches standard 0–127 MIDI PC + 1).">
        {item.program}
      </span>
      <input
        className="text-input"
        type="text"
        value={item.title}
        onChange={(e) => onChange({ title: e.target.value })}
        placeholder="Title"
      />
      <input
        className="text-input chord-line"
        type="text"
        value={item.chords}
        onChange={(e) => onChange({ chords: e.target.value })}
        placeholder="Chords"
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
