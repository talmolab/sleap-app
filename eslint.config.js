import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'src/components/ui', 'src-tauri', 'scratch'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // In the Tauri WebView, window.confirm returns a Promise, which is truthy,
      // so `if (confirm(...))` goes ahead without asking. Use confirmDialog.
      'no-restricted-globals': ['error', {
        name: 'confirm',
        message: 'Use confirmDialog from @/stores/confirmStore: confirm() never asks in the desktop app.',
      }],
      'no-restricted-properties': ['error', {
        object: 'window',
        property: 'confirm',
        message: 'Use confirmDialog from @/stores/confirmStore: window.confirm never asks in the desktop app.',
      }],
    },
  },
)
