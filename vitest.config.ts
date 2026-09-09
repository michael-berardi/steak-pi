import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: {
      // Keep unit tests hermetic: no cross-process slot files, default caps.
      STEAK_PI_USAP_MACHINE: "off",
    },
  },
});
