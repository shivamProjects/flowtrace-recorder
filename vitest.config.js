import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom rather than happy-dom: these tests assert that a generated selector
    // actually selects its element, and happy-dom's attribute-selector engine
    // silently fails on apostrophes and CSS escape sequences — which are
    // precisely the cases under test.
    environment: 'jsdom',
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.js'],
    globals: false,
  },
});
