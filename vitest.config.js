import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees under `.claude/` carry a full copy of this suite. Collecting them
    // runs every rule twice — once against a tree nobody is looking at — and a failure
    // there reads as a failure here.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },
});
