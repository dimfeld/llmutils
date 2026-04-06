import tailwindcss from '@tailwindcss/vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import * as path from 'path';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(), devtoolsJson()],
  server: {
    port: process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8124,
    watch: {
      ignored: ['tasks/**', '.jj/**'],
    },
  },
  test: {
    silent: 'passed-only',
    projects: [
      // {
      //   extends: './vite.config.ts',
      //   test: {
      //     name: 'client',
      //     browser: {
      //       enabled: true,
      //       provider: playwright(),
      //       instances: [{ browser: 'chromium', headless: true }],
      //     },
      //     include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
      //     exclude: ['src/lib/server/**'],
      //   },
      // },

      {
        extends: './vite.config.ts',
        test: {
          name: 'server',
          environment: 'node',
          setupFiles: ['src/vitest-setup.ts'],
          env: {
            PATH: `${path.join(import.meta.dirname, 'test', 'mocks')}:${process.env.PATH || ''}`,
          },
          // adding files one at a time until we know everything passes with vitest
          include: ['src/**/*.test.ts'],
          exclude: ['src/rmfilter/**/*.test.ts'],
          // exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
        },
      },
    ],
  },
});
