import { h } from 'preact';

interface DirectoriesViewProps {
  dirs: string[];
  activeCwd?: string;
  onSelect: (dir: string) => void;
}

/** Extract a short display name from an absolute path (last 2 segments). */
function shortName(dir: string): string {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || dir;
}

export function DirectoriesView({ dirs, activeCwd, onSelect }: DirectoriesViewProps) {
  return (
    <div class="directories-view">
      <h2 class="directories-heading">Directories</h2>
      {dirs.map((dir) => (
        <button
          key={dir}
          class={`directory-card ${dir === activeCwd ? 'directory-card-active' : ''}`}
          onClick={() => onSelect(dir)}
          role="option"
          aria-selected={dir === activeCwd}
        >
          <span class="material-symbols-outlined directory-card-icon" aria-hidden="true">folder</span>
          <div class="directory-card-info">
            <div class="directory-card-name">{shortName(dir)}</div>
            <div class="directory-card-path">{dir}</div>
          </div>
          <span class="material-symbols-outlined" aria-hidden="true" style={{ color: 'var(--text-secondary)' }}>chevron_right</span>
        </button>
      ))}
    </div>
  );
}
