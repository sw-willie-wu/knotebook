import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // destructure-omit（`const { X, ...rest } = obj`，只為了拿掉 X）是慣用法，
      // 不該因為 X 沒被單獨使用就報錯——見 apps/server/test/unit/config.test.ts。
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    // apps/web 是唯一跑在瀏覽器（非 Node）的 workspace package：補瀏覽器 global
    // （window/document/localStorage/fetch/...）避免 no-undef 誤報，並掛
    // react-hooks 的核心兩條 lint 規則（rules-of-hooks/exhaustive-deps）。
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
