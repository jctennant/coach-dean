import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    // .claude/worktrees/** holds other agents' in-progress git worktrees nested inside
    // this repo directory — vitest's default recursive glob picks up their test files
    // too, which can fail for reasons that have nothing to do with this repo's state
    // (e.g. a dependency that worktree hasn't installed yet). Exclude it explicitly,
    // alongside vitest's own defaults (specifying `exclude` replaces them, not merges).
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*",
      "**/.claude/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/lib/**", "src/app/api/**"],
      exclude: ["src/app/api/admin/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
