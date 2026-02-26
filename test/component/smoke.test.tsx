/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { h } from 'preact';

function Greeting({ name }: { name: string }) {
  return <span>Hello, {name}!</span>;
}

describe('Preact smoke test', () => {
  it('renders a component', () => {
    render(<Greeting name="Uplink" />);
    expect(screen.getByText('Hello, Uplink!')).toBeTruthy();
  });
});
