import tailwindcss from '@tailwindcss/vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'path';

function createPlaywrightTestEnv() {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-playwright-test-'));
  const cleanup = () => {
    try {
      fs.rmSync(configRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures during process shutdown.
    }
  };

  process.once('exit', cleanup);

  return {
    PATH: `${path.join(import.meta.dirname, 'test', 'mocks')}:${process.env.PATH || ''}`,
    TIM_DATABASE_FILENAME: 'tim.playwright.test.db',
    TIM_NOTIFY_SUPPRESS: '1',
    TIM_NOTIFY_SUPPRESS_INNER: '1',
    TIM_LOAD_GLOBAL_CONFIG: '0',
    XDG_CONFIG_HOME: configRoot,
  };
}

const playwrightTestEnv = createPlaywrightTestEnv();

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
      {
        extends: './vite.config.ts',
        test: {
          name: 'client',
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: 'chromium', headless: true }],
          },
          env: playwrightTestEnv,
          include: ['src/**/*.svelte.e2e.{test,spec}.{js,ts}'],
          exclude: ['src/lib/server/**'],
        },
      },

      {
        extends: './vite.config.ts',
        test: {
          name: 'server',
          environment: 'node',
          setupFiles: ['src/vitest-setup.ts'],
          env: {
            PATH: `${path.join(import.meta.dirname, 'test', 'mocks')}:${process.env.PATH || ''}`,
          },
          include: ['src/**/*.test.ts'],
          exclude: ['src/rmfilter/**/*.test.ts', 'src/**/*.svelte.e2e.{test,spec}.{js,ts}'],
        },
      },
    ],
  },
});
