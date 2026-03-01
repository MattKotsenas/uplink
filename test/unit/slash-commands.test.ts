import { describe, it, expect } from 'vitest';
import { commands, getCompletions, parseSlashCommand, setAvailableModels, findModelName } from '../../src/client/slash-commands';

describe('slash-commands', () => {
  describe('/session options', () => {
    it('should only have "rename" and "list" as sub-options', () => {
      const session = commands.find((c) => c.name === 'session');
      expect(session).toBeDefined();
      const values = session!.options!.map((o) => o.value);
      expect(values).toEqual(['rename', 'list']);
    });

    it('should not include "create" or "resume" options', () => {
      const session = commands.find((c) => c.name === 'session');
      const values = session!.options!.map((o) => o.value);
      expect(values).not.toContain('create');
      expect(values).not.toContain('resume');
    });
  });

  describe('acceptCompletion / fill behavior', () => {
    it('command with trailing space is not complete (needs sub-option)', () => {
      const parsed = parseSlashCommand('/session ');
      // "/session " has an empty arg — not complete since session has options
      expect(parsed).toBeDefined();
      expect(parsed!.complete).toBe(false);
    });

    it('/session rename is not complete (rename needs a name argument)', () => {
      const parsed = parseSlashCommand('/session rename');
      // "rename" is a sub-option keyword, not a full command — shouldn't auto-execute
      expect(parsed).toBeDefined();
      expect(parsed!.complete).toBe(false);
    });

    it('/session rename My Session is complete', () => {
      const parsed = parseSlashCommand('/session rename My Session');
      expect(parsed).toBeDefined();
      expect(parsed!.complete).toBe(true);
    });

    it('/session list is complete', () => {
      const parsed = parseSlashCommand('/session list');
      expect(parsed).toBeDefined();
      expect(parsed!.complete).toBe(true);
    });

    it('/theme dark is complete', () => {
      const parsed = parseSlashCommand('/theme dark');
      expect(parsed).toBeDefined();
      expect(parsed!.complete).toBe(true);
    });

    it('/agent is complete (no sub-options)', () => {
      const parsed = parseSlashCommand('/agent');
      expect(parsed).toBeDefined();
      expect(parsed!.complete).toBe(true);
    });
  });

  describe('/clear command', () => {
    it('/clear is registered as a client command', () => {
      const cmd = commands.find((c) => c.name === 'clear');
      expect(cmd).toBeDefined();
      expect(cmd!.kind).toBe('client');
    });

    it('/clear parses as complete with no options', () => {
      const parsed = parseSlashCommand('/clear');
      expect(parsed).toBeDefined();
      expect(parsed!.command).toBe('/clear');
      expect(parsed!.kind).toBe('client');
      expect(parsed!.complete).toBe(true);
      expect(parsed!.arg).toBe('');
    });
  });

  describe('mode commands are client-side', () => {
    it('/agent is a client command', () => {
      const cmd = commands.find((c) => c.name === 'agent');
      expect(cmd!.kind).toBe('client');
    });

    it('/plan is a client command', () => {
      const cmd = commands.find((c) => c.name === 'plan');
      expect(cmd!.kind).toBe('client');
    });

    it('/autopilot is a client command', () => {
      const cmd = commands.find((c) => c.name === 'autopilot');
      expect(cmd!.kind).toBe('client');
    });

    it('/autopilot parses as client kind', () => {
      const parsed = parseSlashCommand('/autopilot');
      expect(parsed).toBeDefined();
      expect(parsed!.kind).toBe('client');
      expect(parsed!.command).toBe('/autopilot');
      expect(parsed!.arg).toBe('');
    });

    it('/autopilot fix the bug has remaining arg', () => {
      const parsed = parseSlashCommand('/autopilot fix the bug');
      expect(parsed).toBeDefined();
      expect(parsed!.kind).toBe('client');
      expect(parsed!.arg).toBe('fix the bug');
    });
  });

  describe('getCompletions shows sub-options after command selection', () => {
    it('shows sub-options for "/session "', () => {
      const items = getCompletions('/session ');
      expect(items.length).toBeGreaterThan(0);
      expect(items.map((i) => i.label)).toContain('Rename');
    });

    it('shows all commands for "/"', () => {
      const items = getCompletions('/');
      expect(items.length).toBe(commands.length);
    });

    it('filters commands by prefix', () => {
      const items = getCompletions('/se');
      expect(items.length).toBe(1);
      expect(items[0].label).toBe('/session');
    });

    it('returns empty for non-slash text', () => {
      expect(getCompletions('hello')).toEqual([]);
    });
  });

  describe('model completions', () => {
    it('filters model sub-options by substring match', () => {
      setAvailableModels([
        { modelId: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
        { modelId: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
        { modelId: 'gpt-5.1', name: 'GPT-5.1' },
      ]);

      // "haiku" matches within "Claude Haiku 4.5" and "claude-haiku-4.5"
      const items = getCompletions('/model haiku');
      expect(items.length).toBe(1);
      expect(items[0].label).toBe('Claude Haiku 4.5');
    });

    it('shows all models for "/model "', () => {
      setAvailableModels([
        { modelId: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
        { modelId: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
      ]);

      const items = getCompletions('/model ');
      expect(items.length).toBe(2);
    });

    it('findModelName returns display name by substring match', () => {
      setAvailableModels([
        { modelId: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
        { modelId: 'claude-haiku-4.5', name: 'Claude Haiku 4.5' },
      ]);

      expect(findModelName('haiku')).toBe('Claude Haiku 4.5');
      expect(findModelName('claude-sonnet-4')).toBe('Claude Sonnet 4');
      expect(findModelName('unknown')).toBeUndefined();
    });
  });
});
