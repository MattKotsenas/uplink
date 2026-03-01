/**
 * Slash command registry and routing.
 *
 * Commands are either "client" (handled locally) or "cli" (sent as a prompt).
 * CLI commands like /model and /plan are handled natively by the Copilot CLI.
 */

import type { PaletteItem } from './ui/command-palette.js';

export interface SlashCommandOption {
  label: string;
  value: string;
  detail?: string;
  /** If true, this option requires additional freeform text after it. */
  needsArg?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  /** "cli" commands are sent as session/prompt. "client" commands are intercepted. */
  kind: 'cli' | 'client';
  /** Static sub-options (e.g., /theme light|dark|auto). */
  options?: SlashCommandOption[];
  /** Dynamic sub-options resolved at runtime (e.g., /model lists from ACP). */
  getOptions?: () => SlashCommandOption[];
}

// Populated from the session/new response's models.availableModels field
let availableModels: SlashCommandOption[] = [];

export function setAvailableModels(
  models: Array<{ modelId: string; name: string; _meta?: { copilotUsage?: string } }>,
): void {
  availableModels = models.map((m) => ({
    label: m.name,
    value: m.modelId,
    detail: m._meta?.copilotUsage,
  }));
}

/** Find the display name for a model by partial match (same logic as completions). */
export function findModelName(arg: string): string | undefined {
  const term = arg.toLowerCase();
  const match = availableModels.find(
    (m) => m.value.toLowerCase().includes(term) || m.label.toLowerCase().includes(term),
  );
  return match?.label;
}

export const commands: SlashCommand[] = [
  {
    name: 'model',
    description: 'Switch AI model',
    kind: 'cli',
    getOptions: () => availableModels,
  },
  { name: 'agent', description: 'Default agent mode', kind: 'client' },
  { name: 'plan', description: 'Plan mode', kind: 'client' },
  { name: 'autopilot', description: 'Autonomous mode', kind: 'client' },
  {
    name: 'theme',
    description: 'Set color theme',
    kind: 'client',
    options: [
      { label: 'Dark', value: 'dark' },
      { label: 'Light', value: 'light' },
      { label: 'Auto', value: 'auto' },
    ],
  },
  {
    name: 'yolo',
    description: 'Auto-approve permissions',
    kind: 'client',
    options: [
      { label: 'On', value: 'on' },
      { label: 'Off', value: 'off' },
    ],
  },
  {
    name: 'session',
    description: 'Manage sessions',
    kind: 'client',
    options: [
      { label: 'Rename', value: 'rename', needsArg: true },
      { label: 'List', value: 'list' },
    ],
  },
  { name: 'clear', description: 'Clear conversation', kind: 'client' },
];

export interface ParsedCommand {
  command: string;
  arg: string;
  kind: 'cli' | 'client';
  /** True when the command + argument form a complete, executable command. */
  complete: boolean;
}

/** Try to parse a slash command from input text. Returns undefined if not a command. */
export function parseSlashCommand(text: string): ParsedCommand | undefined {
  if (!text.startsWith('/')) return undefined;

  const parts = text.slice(1).split(/\s+/, 2);
  const name = parts[0]?.toLowerCase();
  const arg = text.slice(1 + name.length).trim();

  const command = commands.find((c) => c.name === name);
  if (!command) {
    // Unknown slash command — send to CLI as-is
    return { command: `/${name}`, arg, kind: 'cli', complete: true };
  }

  // A command is "complete" if it has no options, or if an arg satisfies the requirement
  const hasOptions = (command.options?.length ?? 0) > 0 || command.getOptions != null;
  if (!hasOptions) {
    return { command: `/${command.name}`, arg, kind: command.kind, complete: true };
  }
  if (arg.length === 0) {
    return { command: `/${command.name}`, arg, kind: command.kind, complete: false };
  }

  // Check if the first word of arg matches an option that needs more text
  const argWords = arg.split(/\s+/);
  const options = command.getOptions?.() ?? command.options ?? [];
  const matchedOption = options.find((o) => o.value.toLowerCase() === argWords[0].toLowerCase());
  const complete = matchedOption?.needsArg ? argWords.length > 1 : true;

  return { command: `/${command.name}`, arg, kind: command.kind, complete };
}

/**
 * Get completion items for the command palette based on current input text.
 */
export function getCompletions(text: string): PaletteItem[] {
  if (!text.startsWith('/')) return [];

  const afterSlash = text.slice(1);
  const spaceIdx = afterSlash.indexOf(' ');

  if (spaceIdx === -1) {
    // Still typing the command name — filter commands
    const prefix = afterSlash.toLowerCase();
    return commands
      .filter((c) => c.name.startsWith(prefix))
      .map((c) => ({
        label: `/${c.name}`,
        detail: c.description,
        fill: `/${c.name} `,
      }));
  }

  // Command name is complete — show sub-options
  const name = afterSlash.slice(0, spaceIdx).toLowerCase();
  const argPrefix = afterSlash.slice(spaceIdx + 1).toLowerCase();
  const command = commands.find((c) => c.name === name);
  if (!command) return [];

  const options = command.getOptions?.() ?? command.options ?? [];
  return options
    .filter((o) => o.label.toLowerCase().includes(argPrefix) || o.value.toLowerCase().includes(argPrefix))
    .map((o) => ({
      label: o.label,
      detail: o.detail,
      fill: `/${name} ${o.value}`,
    }));
}
