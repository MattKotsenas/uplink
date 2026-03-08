import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';
import { h } from 'preact';
import { TabBar, type TabId } from '../../src/client/ui/tab-bar';

afterEach(cleanup);

describe('TabBar', () => {
  it('renders both tabs', () => {
    render(<TabBar activeTab="directories" onTabChange={() => {}} />);
    expect(screen.getByText('Directories')).toBeTruthy();
    expect(screen.getByText('Chat')).toBeTruthy();
  });

  it('marks directories tab as active', () => {
    render(<TabBar activeTab="directories" onTabChange={() => {}} />);
    const dirTab = screen.getByText('Directories').closest('button')!;
    const chatTab = screen.getByText('Chat').closest('button')!;
    expect(dirTab.getAttribute('aria-selected')).toBe('true');
    expect(chatTab.getAttribute('aria-selected')).toBe('false');
  });

  it('marks chat tab as active', () => {
    render(<TabBar activeTab="chat" onTabChange={() => {}} />);
    const dirTab = screen.getByText('Directories').closest('button')!;
    const chatTab = screen.getByText('Chat').closest('button')!;
    expect(dirTab.getAttribute('aria-selected')).toBe('false');
    expect(chatTab.getAttribute('aria-selected')).toBe('true');
  });

  it('shows custom chat dir name', () => {
    render(<TabBar activeTab="chat" onTabChange={() => {}} chatDirName="my-project" />);
    expect(screen.getByText('my-project')).toBeTruthy();
  });

  it('shows default label when no chatDirName', () => {
    render(<TabBar activeTab="directories" onTabChange={() => {}} />);
    expect(screen.getByText('Chat')).toBeTruthy();
  });

  it('calls onTabChange when clicking directories tab', () => {
    const onTabChange = vi.fn();
    render(<TabBar activeTab="chat" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByText('Directories').closest('button')!);
    expect(onTabChange).toHaveBeenCalledWith('directories');
  });

  it('calls onTabChange when clicking chat tab', () => {
    const onTabChange = vi.fn();
    render(<TabBar activeTab="directories" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByText('Chat').closest('button')!);
    expect(onTabChange).toHaveBeenCalledWith('chat');
  });

  it('has correct ARIA roles', () => {
    render(<TabBar activeTab="directories" onTabChange={() => {}} />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
  });
});
