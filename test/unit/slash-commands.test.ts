import { describe, it, expect } from 'vitest';
import { commands, getCompletions, parseSlashCommand } from '../../src/client/slash-commands';

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
});
