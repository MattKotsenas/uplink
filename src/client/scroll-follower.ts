/**
 * Manages auto-scroll "follow mode" for a scrollable container.
 *
 * Follow mode keeps the container scrolled to the bottom as new content
 * arrives. It disengages when the user scrolls up and re-engages when
 * the user scrolls back to the bottom.
 *
 * Design:
 * - Uses user-interaction events (wheel, touchstart, pointerdown) to
 *   detect when the user is actively scrolling. Only user-initiated
 *   scroll activity can disengage follow mode.
 * - Uses `scrollTo({ behavior: 'smooth' })` for visually smooth
 *   programmatic scrolling.
 * - Checks the gap from the bottom after user interaction settles to
 *   determine whether to re-engage follow mode.
 */

const BOTTOM_THRESHOLD_PX = 50;
const USER_SCROLL_SETTLE_MS = 150;

export class ScrollFollower {
  private _following = true;
  private userScrolling = false;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners: Array<[string, EventListener, AddEventListenerOptions?]> = [];

  constructor(private readonly container: HTMLElement) {
    this.listen('wheel', () => this.onUserScrollStart(), { passive: true });
    this.listen('touchstart', () => this.onUserScrollStart(), { passive: true });
    this.listen('pointerdown', (e) => {
      // Only track direct pointer interactions on the scrollbar or content
      if ((e as PointerEvent).pointerType !== 'mouse' || (e as PointerEvent).button === 0) {
        this.onUserScrollStart();
      }
    }, { passive: true });
    this.listen('scroll', () => this.onScroll(), { passive: true });
  }

  get following(): boolean {
    return this._following;
  }

  /** Scroll to the bottom if follow mode is active. Call after content changes. */
  scrollIfFollowing(): void {
    if (!this._following) return;
    this.scrollToBottom();
  }

  /** Force-engage follow mode and scroll to bottom. */
  activate(): void {
    this._following = true;
    this.scrollToBottom();
  }

  /** Clean up all event listeners. */
  dispose(): void {
    for (const [type, handler, opts] of this.listeners) {
      this.container.removeEventListener(type, handler, opts);
    }
    this.listeners.length = 0;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
  }

  private listen(
    type: string,
    handler: EventListener,
    opts?: AddEventListenerOptions,
  ): void {
    this.container.addEventListener(type, handler, opts);
    this.listeners.push([type, handler, opts]);
  }

  private onUserScrollStart(): void {
    this.userScrolling = true;
    this.resetSettleTimer();
  }

  private onScroll(): void {
    if (!this.userScrolling) return;
    // Restart the settle timer on each scroll event during user interaction
    this.resetSettleTimer();
  }

  private resetSettleTimer(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
    }
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      this.userScrolling = false;
      this._following = this.gapFromBottom() <= BOTTOM_THRESHOLD_PX;
    }, USER_SCROLL_SETTLE_MS);
  }

  private gapFromBottom(): number {
    return this.container.scrollHeight
      - this.container.scrollTop
      - this.container.clientHeight;
  }

  private scrollToBottom(): void {
    const gap = this.gapFromBottom();
    // Jump instantly when far from bottom (e.g. session resume/switch);
    // smooth scroll when close (e.g. new streaming chunk).
    const behavior = gap > this.container.clientHeight * 5 ? 'instant' : 'smooth';
    if (typeof this.container.scrollTo === 'function') {
      this.container.scrollTo({
        top: this.container.scrollHeight,
        behavior,
      });
    } else {
      this.container.scrollTop = this.container.scrollHeight;
    }
  }
}
