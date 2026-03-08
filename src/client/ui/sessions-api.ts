import type { SessionInfo } from '../../shared/acp-types.js';

export async function fetchSessions(cwd: string): Promise<SessionInfo[]> {
  const params = new URLSearchParams();
  if (cwd) params.set('cwd', cwd);
  const query = params.toString();
  const res = await fetch(query ? `/api/sessions?${query}` : '/api/sessions');
  if (!res.ok) return [];
  const data = await res.json();
  return data.sessions ?? [];
}

export function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
