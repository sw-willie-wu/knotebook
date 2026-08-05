import tseslint from "typescript-eslint";

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
);
