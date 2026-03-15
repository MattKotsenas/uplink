import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ScrollFollower } from '../../src/client/scroll-follower';

/** Create a mock container with controllable scroll geometry. */
function createMockContainer(opts: {
  scrollHeight?: number;
  clientHeight?: number;
  scrollTop?: number;
} = {}) {
  const listeners = new Map<string, Set<EventListener>>();
  let scrollHeight = opts.scrollHeight ?? 2000;
  let clientHeight = opts.clientHeight ?? 500;
  let scrollTop = opts.scrollTop ?? 1500; // default: at bottom

  const container = {
    get scrollHeight() { return scrollHeight; },
    set scrollHeight(v: number) { scrollHeight = v; },
    get clientHeight() { return clientHeight; },
    get scrollTop() { return scrollTop; },
    set scrollTop(v: number) { scrollTop = v; },
    scrollTo(opts: ScrollToOptions) {
      scrollTop = opts.top ?? scrollTop;
    },
    addEventListener(type: string, handler: EventListener, _opts?: AddEventListenerOptions) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: EventListener, _opts?: AddEventListenerOptions) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type: string, eventInit?: Partial<PointerEvent>) {
      const event = { type, ...eventInit } as Event;
      listeners.get(type)?.forEach(h => h(event));
    },
  };

  return container;
}

describe('ScrollFollower', () => {
  let container: ReturnType<typeof createMockContainer>;
  let follower: ScrollFollower;

  beforeEach(() => {
    vi.useFakeTimers();
    container = createMockContainer();
    follower = new ScrollFollower(container as unknown as HTMLElement);
  });

  afterEach(() => {
    follower.dispose();
    vi.useRealTimers();
  });

  // ── Initial state ──────────────────────────────────────────────────

  it('starts in follow mode', () => {
    expect(follower.following).toBe(true);
  });

  // ── Programmatic scroll does not disengage ─────────────────────────

  it('stays in follow mode after scrollIfFollowing', () => {
    follower.scrollIfFollowing();
    // Simulate resulting scroll events (from smooth scroll animation)
    container.dispatch('scroll');
    container.dispatch('scroll');
    container.dispatch('scroll');
    vi.advanceTimersByTime(500);

    expect(follower.following).toBe(true);
  });

  it('scrollIfFollowing calls scrollTo with smooth behavior', () => {
    const spy = vi.spyOn(container, 'scrollTo');
    follower.scrollIfFollowing();

    expect(spy).toHaveBeenCalledWith({
      top: container.scrollHeight,
      behavior: 'smooth',
    });
  });

  // ── User scroll detection ──────────────────────────────────────────

  it('disengages follow mode when user wheels away from bottom', () => {
    // User scrolls up via wheel
    container.dispatch('wheel');
    container.scrollTop = 500; // now far from bottom
    container.dispatch('scroll');

    // Wait for settle
    vi.advanceTimersByTime(200);

    expect(follower.following).toBe(false);
  });

  it('disengages follow mode on touchstart + scroll away from bottom', () => {
    container.dispatch('touchstart');
    container.scrollTop = 300;
    container.dispatch('scroll');

    vi.advanceTimersByTime(200);

    expect(follower.following).toBe(false);
  });

  it('re-engages follow mode when user scrolls back to bottom', () => {
    // First, disengage
    container.dispatch('wheel');
    container.scrollTop = 500;
    container.dispatch('scroll');
    vi.advanceTimersByTime(200);
    expect(follower.following).toBe(false);

    // Now scroll back to bottom
    container.dispatch('wheel');
    container.scrollTop = 1500; // gap = 2000 - 1500 - 500 = 0
    container.dispatch('scroll');
    vi.advanceTimersByTime(200);

    expect(follower.following).toBe(true);
  });

  it('re-engages follow mode when user is within threshold of bottom', () => {
    // Disengage
    container.dispatch('wheel');
    container.scrollTop = 500;
    container.dispatch('scroll');
    vi.advanceTimersByTime(200);
    expect(follower.following).toBe(false);

    // Scroll to within 50px of bottom (gap = 2000 - 1460 - 500 = 40)
    container.dispatch('wheel');
    container.scrollTop = 1460;
    container.dispatch('scroll');
    vi.advanceTimersByTime(200);

    expect(follower.following).toBe(true);
  });

  // ── Smooth scroll animation does not break follow mode ─────────────

  it('does not disengage during smooth scroll animation', () => {
    // Programmatic scroll sets scrollTop, then animation fires events
    follower.scrollIfFollowing();

    // Simulate rapid content growth during animation (new tool call added)
    container.scrollHeight = 3000;
    // Smooth scroll fires intermediate events with big gap
    container.scrollTop = 1500; // gap = 3000 - 1500 - 500 = 1000
    container.dispatch('scroll');
    container.scrollTop = 1800;
    container.dispatch('scroll');
    container.scrollTop = 2100;
    container.dispatch('scroll');

    vi.advanceTimersByTime(500);

    // Should still be following - no user interaction occurred
    expect(follower.following).toBe(true);
  });

  it('does not disengage when content grows between programmatic scrolls', () => {
    // First programmatic scroll
    follower.scrollIfFollowing();
    container.scrollTop = 2000;
    container.dispatch('scroll');

    // Content grows (tool call added)
    container.scrollHeight = 3000;
    // Fire scroll events from the animation with gap > threshold
    container.dispatch('scroll');

    // Second programmatic scroll
    follower.scrollIfFollowing();
    container.dispatch('scroll');

    vi.advanceTimersByTime(500);

    expect(follower.following).toBe(true);
  });

  // ── scrollIfFollowing does nothing when not following ───────────────

  it('does not scroll when follow mode is disengaged', () => {
    // Disengage
    container.dispatch('wheel');
    container.scrollTop = 500;
    container.dispatch('scroll');
    vi.advanceTimersByTime(200);

    const spy = vi.spyOn(container, 'scrollTo');
    follower.scrollIfFollowing();

    expect(spy).not.toHaveBeenCalled();
  });

  // ── activate() ─────────────────────────────────────────────────────

  it('activate re-engages follow mode and scrolls to bottom', () => {
    // Disengage
    container.dispatch('wheel');
    container.scrollTop = 500;
    container.dispatch('scroll');
    vi.advanceTimersByTime(200);
    expect(follower.following).toBe(false);

    // Force activate
    follower.activate();
    expect(follower.following).toBe(true);
  });

  // ── dispose() ──────────────────────────────────────────────────────

  it('removes all event listeners on dispose', () => {
    const spy = vi.spyOn(container, 'removeEventListener');
    follower.dispose();

    // Should have removed wheel, touchstart, pointerdown, scroll
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('stops tracking after dispose', () => {
    follower.dispose();
    // These should be no-ops
    container.dispatch('wheel');
    container.scrollTop = 0;
    container.dispatch('scroll');
    vi.advanceTimersByTime(200);

    // following should still be true (initial value, never changed)
    expect(follower.following).toBe(true);
  });
});
