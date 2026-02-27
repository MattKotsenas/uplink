import { h } from 'preact';

export interface PaletteItem {
  label: string;
  detail?: string;
  /** Text to insert into the input when this item is selected. */
  fill: string;
}

interface CommandPaletteProps {
  items: PaletteItem[];
  selectedIndex: number;
  onSelect: (item: PaletteItem) => void;
  onHover: (index: number) => void;
}

export function CommandPalette({ items, selectedIndex, onSelect, onHover }: CommandPaletteProps) {
  if (items.length === 0) return null;

  return (
    <div class="command-palette" role="listbox" aria-label="Slash commands">
      {items.map((item, i) => (
        <div
          key={item.fill}
          class={`command-palette-item${i === selectedIndex ? ' selected' : ''}`}
          role="option"
          aria-selected={i === selectedIndex}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(item);
          }}
        >
          <span class="command-palette-label">{item.label}</span>
          {item.detail && <span class="command-palette-detail">{item.detail}</span>}
        </div>
      ))}
    </div>
  );
}
