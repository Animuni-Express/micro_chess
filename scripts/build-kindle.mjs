// Kindle bundle build: esbuild alone cannot emit ES5 (it refuses to lower
// const/let/destructuring), but the Kindle experimental browser is an old
// WebKit that chokes on any ES2015 syntax — one SyntaxError and the whole
// bundle silently does nothing. So: esbuild bundles JSX -> ES2015, Babel
// lowers that to genuine ES5, and a final esbuild pass minifies at
// target=es5, which doubles as a hard verification that no post-ES5
// syntax survived (esbuild errors out if any did).
import { build, transform } from 'esbuild';
import { transformAsync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import { writeFileSync } from 'node:fs';

const bundled = await build({
  entryPoints: ['./src/kindle/main-kindle.jsx'],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2015',
  jsx: 'automatic',
  jsxImportSource: 'preact',
});

const es5 = await transformAsync(bundled.outputFiles[0].text, {
  // IE 9 forces full ES5 down-leveling; runtime gaps (Promise, fetch, Set…)
  // are covered by src/kindle/polyfills.js, so no core-js injection needed.
  presets: [[presetEnv, { targets: { ie: '9' }, modules: false, useBuiltIns: false }]],
  babelrc: false,
  configFile: false,
  compact: false,
});

const minified = await transform(es5.code, { minify: true, target: 'es5' });

writeFileSync('public/bundle-kindle.js', minified.code);
console.log(`bundle-kindle.js: ${(minified.code.length / 1024).toFixed(1)}kb (ES5)`);
