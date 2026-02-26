import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import type { PlanEntry } from '../../shared/acp-types.js';
import { Conversation } from '../conversation.js';

const STATUS_ICONS: Record<PlanEntry['status'], string> = {
  pending: '⏳',
  in_progress: '🔄',
  completed: '✅',
};

function PlanEntryRow({ entry }: { entry: PlanEntry }) {
  const statusClass = entry.status === 'in_progress' ? 'in-progress' : entry.status;
  return (
    <li class={`plan-entry ${statusClass}`}>
      <span class="plan-status-icon">{STATUS_ICONS[entry.status]}</span>
      <span class="plan-content">{entry.content}</span>
      <span class={`plan-priority priority-${entry.priority}`}>{entry.priority}</span>
    </li>
  );
}

export function PlanCard({ conversation }: { conversation: Conversation }) {
  const [, setVersion] = useState(0);

  useEffect(() => {
    return conversation.onChange(() => setVersion((v) => v + 1));
  }, [conversation]);

  const plan = conversation.plan;
  if (!plan) return null;

  return (
    <div class="plan-card">
      <div class="plan-header">📋 Plan</div>
      <ul class="plan">
        {plan.entries.map((entry, i) => (
          <PlanEntryRow key={i} entry={entry} />
        ))}
      </ul>
    </div>
  );
}
