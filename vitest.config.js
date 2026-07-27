import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        setupFiles: ['./tests/setup.js'],
        coverage: {
            provider: 'v8',
            // `all` reports files no test ever imported as 0% instead of
            // omitting them, so untested modules stay visible in the summary.
            all: true,
            include: ['src/**/*.js'],
            exclude: ['**/*.min.js'],
            // Still emit the report when tests fail — otherwise a single
            // red test hides the coverage numbers for the whole suite.
            reportOnFailure: true,
            reporter: ['text-summary', 'json-summary', 'html'],
            reportsDirectory: './coverage',
            // A floor, not a goal. Set just under the current numbers so the
            // gate is green today and catches *regression* — a deleted test
            // in a 100-file suite is otherwise invisible. `autoUpdate` walks
            // these up whenever a run beats them (commit the bump), so the
            // floor only ever rises.
            //
            // Deliberately NOT `perFile` — that fails on every file without
            // a test, which is most of them right now.
            //
            // src/index.js and src/web/server.js (~1.8k lines of bootstrap
            // and CLI wiring) are the reason the global number is low. They
            // stay in the report for visibility but should never drive the
            // target.
            thresholds: {
                // `autoUpdate` is off on purpose. It pins the thresholds to
                // the exact figure of the last green run (17.79, 14.27, …),
                // which leaves no slack: one timing-sensitive test that
                // flakes under load takes its lines with it and reds the
                // build for a reason that has nothing to do with coverage.
                // Round floors a point below reality, bumped by hand when a
                // phase lands, trade a little precision for a gate people
                // still trust.
                autoUpdate: false,
                lines: 17,
                statements: 16,
                functions: 18,
                branches: 14,
                // Earned ground. These are done — hold them there. Note that
                // a glob threshold aggregates across every file it matches,
                // it is not applied per file.
                'src/web/public/js/{utils,media-url,router,gallery-select}.js': {
                    lines: 95,
                    functions: 95,
                    branches: 85,
                },
                'src/config/**': { lines: 85 },
            },
        },
    },
});
