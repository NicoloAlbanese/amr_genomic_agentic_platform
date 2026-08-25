module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
  collectCoverageFrom: [
    'lib/**/*.ts',
    '../src/api/**/*.ts',
    '!lib/infra-stack.ts',   // placeholder stub
    '!**/*.d.ts',
  ],
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 50,
      functions: 60,
      lines: 70,
    },
  },
  coverageReporters: ['text', 'lcov', 'html'],
  moduleNameMapper: {
    // Map @aws-sdk modules used by src/api/ handlers — they are externalized in
    // esbuild production builds but need to be resolvable during Jest runs.
    '^@aws-sdk/client-sfn$': '<rootDir>/node_modules/@aws-sdk/client-sfn',
    '^@aws-sdk/client-lambda$': '<rootDir>/node_modules/@aws-sdk/client-lambda',
  },
  globals: {
    'ts-jest': {
      diagnostics: {
        // Ignore TS2307 errors for @aws-sdk packages during tests
        // (they are externalized in esbuild bundling; mocked in tests)
        ignoreCodes: ['TS2307'],
      },
    },
  },
  testTimeout: 120000,
};
