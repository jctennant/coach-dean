import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // after() swallows errors thrown inside it — background work must go through
  // runAfter() (src/lib/safe-after.ts) so failures reach the logs and Sentry.
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/lib/safe-after.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next/server",
              importNames: ["after"],
              message:
                "Use runAfter() from @/lib/safe-after instead of after() — after() swallows errors (see CLAUDE.md silent-failure notes).",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
