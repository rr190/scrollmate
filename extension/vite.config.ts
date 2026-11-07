import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Three builds share one dist/ folder:
//   content    -> dist/content.js     (IIFE: content scripts cannot be ES modules)
//   background -> dist/background.js  (IIFE service worker)
//   stage      -> dist/stage.html     (offline demo stage, an extension page)
export default defineConfig(({ mode }) => {
  const define = { 'process.env.NODE_ENV': JSON.stringify('production') };

  if (mode === 'content' || mode === 'background') {
    const entry = mode === 'content' ? 'src/content/index.tsx' : 'src/background/index.ts';
    return {
      plugins: [react()],
      define,
      publicDir: mode === 'content' ? 'public' : false,
      build: {
        outDir: 'dist',
        emptyOutDir: mode === 'content',
        sourcemap: false,
        lib: {
          entry: resolve(__dirname, entry),
          name: mode === 'content' ? 'ScrollMateContent' : 'ScrollMateBackground',
          formats: ['iife'],
          fileName: () => `${mode}.js`,
        },
      },
    };
  }

  return {
    plugins: [react()],
    define,
    publicDir: false,
    base: './',
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      rollupOptions: { input: resolve(__dirname, 'stage.html') },
    },
  };
});
