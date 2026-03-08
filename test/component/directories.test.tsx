import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';
import { h } from 'preact';
import { DirectoriesView } from '../../src/client/ui/directories';

afterEach(cleanup);

describe('DirectoriesView', () => {
  const dirs = ['/Users/me/projects/alpha', '/Users/me/projects/beta'];

  it('renders all directories', () => {
    render(<DirectoriesView dirs={dirs} onSelect={() => {}} />);
    expect(screen.getByText('projects/alpha')).toBeTruthy();
    expect(screen.getByText('projects/beta')).toBeTruthy();
  });

  it('shows full path for each directory', () => {
    render(<DirectoriesView dirs={dirs} onSelect={() => {}} />);
    expect(screen.getByText('/Users/me/projects/alpha')).toBeTruthy();
    expect(screen.getByText('/Users/me/projects/beta')).toBeTruthy();
  });

  it('shows heading', () => {
    render(<DirectoriesView dirs={dirs} onSelect={() => {}} />);
    expect(screen.getByText('Directories')).toBeTruthy();
  });

  it('calls onSelect with correct dir when clicked', () => {
    const onSelect = vi.fn();
    render(<DirectoriesView dirs={dirs} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('projects/alpha').closest('button')!);
    expect(onSelect).toHaveBeenCalledWith('/Users/me/projects/alpha');
  });

  it('marks active directory', () => {
    render(<DirectoriesView dirs={dirs} activeCwd={dirs[1]} onSelect={() => {}} />);
    const buttons = screen.getAllByRole('option');
    expect(buttons[0].getAttribute('aria-selected')).toBe('false');
    expect(buttons[1].getAttribute('aria-selected')).toBe('true');
  });

  it('renders empty list without errors', () => {
    render(<DirectoriesView dirs={[]} onSelect={() => {}} />);
    expect(screen.getByText('Directories')).toBeTruthy();
  });

  it('handles single-segment paths', () => {
    render(<DirectoriesView dirs={['/root']} onSelect={() => {}} />);
    // shortName of '/root' is just 'root'
    expect(screen.getByText('root')).toBeTruthy();
  });
});
