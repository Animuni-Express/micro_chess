// Jest transform built on esbuild (already a devDependency for the app bundles),
// so tests can import the project's ESM/JSX sources without adding a Babel
// toolchain.
const { transformSync } = require('esbuild');

module.exports = {
  process(source, filename) {
    const loader = filename.endsWith('.jsx') ? 'jsx' : filename.endsWith('.ts') ? 'ts' : 'js';
    const { code } = transformSync(source, {
      loader,
      format: 'cjs',
      target: 'node18',
      sourcefile: filename,
      sourcemap: 'inline',
    });
    return { code };
  },
};
