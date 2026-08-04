module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  transform: {
    '^.+\\.(js|jsx|mjs|ts)$': '<rootDir>/tests/esbuild-transformer.cjs',
  },
  // chess.js 0.13 ships ESM/CJS interop that needs transforming too.
  transformIgnorePatterns: ['/node_modules/(?!chess\\.js)'],
};
