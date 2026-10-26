import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Database tests talk to Atlas over the internet, so allow more time than the 5-second default.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});