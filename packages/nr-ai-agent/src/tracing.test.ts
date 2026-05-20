import { initTracer, getTracer } from './tracing.js';

describe('initTracer', () => {
  it('initTracer() can be called multiple times without throwing', () => {
    expect(() => {
      initTracer();
      initTracer();
    }).not.toThrow();
  });

  it('getTracer() returns a Tracer object before initTracer()', () => {
    expect(getTracer()).toBeDefined();
  });
});
