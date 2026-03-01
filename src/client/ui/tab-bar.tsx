import { h } from 'preact';

export type TabId = 'directories' | 'chat';

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  chatDirName?: string;
}

export function TabBar({ activeTab, onTabChange, chatDirName }: TabBarProps) {
  return (
    <nav class="tab-bar" role="tablist">
      <button
        class={`tab-bar-item ${activeTab === 'directories' ? 'active' : ''}`}
        role="tab"
        aria-selected={activeTab === 'directories'}
        onClick={() => onTabChange('directories')}
      >
        <span class="material-symbols-outlined" aria-hidden="true">folder</span>
        <span class="tab-bar-label">Directories</span>
      </button>
      <button
        class={`tab-bar-item ${activeTab === 'chat' ? 'active' : ''}`}
        role="tab"
        aria-selected={activeTab === 'chat'}
        onClick={() => onTabChange('chat')}
      >
        <span class="material-symbols-outlined" aria-hidden="true">chat</span>
        <span class="tab-bar-label">{chatDirName || 'Chat'}</span>
      </button>
    </nav>
  );
}
