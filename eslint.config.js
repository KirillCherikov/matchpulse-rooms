import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "web/dist/**", "node_modules/**", "coverage/**", "playwright-report/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser
    }
  },
  prettier
);
