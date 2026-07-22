/**
 * jsdom shims.
 *
 * Loaded before any test module, because uPlot touches matchMedia at import time -- stubbing
 * inside a test is too late.
 */
if (typeof window !== 'undefined') {
  if (window.matchMedia === undefined) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  if (globalThis.ResizeObserver === undefined) {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }

  // jsdom always reports offsetParent as null, and react-grid-layout's drag start does
  // `if (!offsetParent) return;` -- so without this a drag silently never begins and the
  // library looks broken when it is not.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement ?? document.body;
    },
  });

  // jsdom has no canvas; uPlot only needs the calls to not throw.
  HTMLCanvasElement.prototype.getContext = (() => ({
    save: () => {}, restore: () => {}, fillRect: () => {}, clearRect: () => {},
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {}, fill: () => {},
    translate: () => {}, scale: () => {}, rect: () => {}, clip: () => {},
    measureText: () => ({ width: 0 }), fillText: () => {}, setLineDash: () => {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
