import tailwindcss from '@tailwindcss/vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { defineConfig } from 'vite';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(), devtoolsJson()],
  server: {
    port: process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8124,
    watch: {
      ignored: ['tasks/**', '.jj/**'],
    },
  },
  test: {
    expect: { requireAssertions: true },
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
          include: ['src/lib/**/*.{test,spec}.{js,ts}', 'src/routes/**/*.{test,spec}.{js,ts}'],
          // exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
        },
      },
    ],
  },
});
