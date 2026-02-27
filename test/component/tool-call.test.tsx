/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { h } from 'preact';
import { ToolCallCard } from '../../src/client/ui/tool-call.js';
import type { TrackedToolCall } from '../../src/client/conversation.js';

afterEach(cleanup);

function makeTc(overrides: Partial<TrackedToolCall> = {}): TrackedToolCall {
  return {
    toolCallId: 'tc-1',
    title: 'Read file.ts',
    kind: 'read',
    status: 'pending',
    content: [],
    locations: [],
    ...overrides,
  };
}

describe('ToolCallCard', () => {
  it('renders a tool call with icon, title, and status', () => {
    const { container } = render(<ToolCallCard tc={makeTc()} />);

    expect(container.querySelector('.kind-icon')!.textContent).toBe('description');
    expect(container.querySelector('.tool-call-title')!.textContent).toBe('Read file.ts');
    expect(container.querySelector('.status')!.textContent).toBe('pending');
  });

  it('renders thinking block as <details>', () => {
    const tc = makeTc({
      toolCallId: 'think-1',
      kind: 'think',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'Analyzing...' } }],
    });
    const { container } = render(<ToolCallCard tc={tc} />);

    const details = container.querySelector('details.tool-call-thinking');
    expect(details).toBeTruthy();
    expect(container.querySelector('.tool-call-title')!.textContent).toBe('Thinking…');
    // Status class should be kebab-case, not snake_case
    expect(container.querySelector('.status.in-progress')).toBeTruthy();
  });

  it('thinking shows "Thought" when completed', () => {
    const tc = makeTc({
      toolCallId: 'think-2',
      kind: 'think',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Done thinking.' } }],
    });
    const { container } = render(<ToolCallCard tc={tc} />);
    expect(container.querySelector('.tool-call-title')!.textContent).toBe('Thought');
  });

  it('body is collapsed by default for non-thinking tool calls', () => {
    const tc = makeTc({
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Found 3 results' } }],
    });
    const { container } = render(<ToolCallCard tc={tc} />);
    const body = container.querySelector('.tool-call-body') as HTMLElement;
    expect(body.hidden).toBe(true);
  });

  it('expands body on header click', () => {
    const tc = makeTc({
      kind: 'execute',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Output here' } }],
    });
    const { container } = render(<ToolCallCard tc={tc} />);
    const header = container.querySelector('.tool-call-header')!;
    const body = container.querySelector('.tool-call-body') as HTMLElement;

    expect(body.hidden).toBe(true);
    fireEvent.click(header);
    expect(body.hidden).toBe(false);
    fireEvent.click(header);
    expect(body.hidden).toBe(true);
  });

  it('renders diff content with old/new text', () => {
    const tc = makeTc({
      kind: 'edit',
      title: 'Edit file',
      status: 'completed',
      content: [{
        type: 'diff',
        path: 'src/app.ts',
        oldText: 'const x = 1;',
        newText: 'const x = 2;',
      }],
    });
    const { container } = render(<ToolCallCard tc={tc} />);
    fireEvent.click(container.querySelector('.tool-call-header')!);

    expect(container.textContent).toContain('src/app.ts');
    expect(container.textContent).toContain('const x = 1;');
    expect(container.textContent).toContain('const x = 2;');
  });

  it('shows "No output" when content is empty', () => {
    const tc = makeTc({ status: 'completed' });
    const { container } = render(<ToolCallCard tc={tc} />);
    fireEvent.click(container.querySelector('.tool-call-header')!);

    expect(container.querySelector('.tool-call-empty')!.textContent).toBe('No output');
  });

  it('uses correct Material Symbols icon for each kind', () => {
    const kinds = [
      { kind: 'read', icon: 'description' },
      { kind: 'edit', icon: 'edit' },
      { kind: 'execute', icon: 'terminal' },
      { kind: 'fetch', icon: 'language' },
      { kind: 'search', icon: 'search' },
      { kind: 'delete', icon: 'delete' },
      { kind: 'move', icon: 'drive_file_move' },
      { kind: 'other', icon: 'settings' },
    ] as const;

    for (const { kind, icon } of kinds) {
      cleanup();
      const tc = makeTc({ toolCallId: `tc-${kind}`, kind, title: kind });
      const { container } = render(<ToolCallCard tc={tc} />);
      expect(container.querySelector('.kind-icon')!.textContent).toBe(icon);
    }
  });
});
