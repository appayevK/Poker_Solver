// Vite config: the Flop tab loads data/flops/* by computed path at runtime, so the
// production build copies that folder next to the app (the dev server serves it as is).
import { defineConfig } from 'vite';
import { cpSync, existsSync } from 'node:fs';

export default defineConfig({
  plugins: [
    {
      name: 'copy-flop-data',
      apply: 'build',
      closeBundle() {
        if (existsSync('data/flops')) cpSync('data/flops', 'dist/data/flops', { recursive: true });
      },
    },
  ],
});
