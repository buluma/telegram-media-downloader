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
                // Bumped as each batch lands, a point or so under the
                // measured figure. P1+P2 (routes + frontend leaves) took this
                // from 17/16/18/14; P3 (core hot spots) reached
                // 44.53/43.23/45.45/36.45; P4 so far (7 of 11 frontend
                // modules) measures 52.04/50.61/52.24/43.20.
                //
                // Bumped mid-phase on purpose rather than at the end: leaving
                // the floor at the P3 numbers meant a ~6-point gap in which a
                // deleted P4 test file would not have reddened the build.
                lines: 50,
                statements: 49,
                functions: 51,
                branches: 42,
                // Earned ground. These are done — hold them there. Note that
                // a glob threshold aggregates across every file it matches,
                // it is not applied per file.
                'src/web/public/js/{utils,media-url,router,gallery-select}.js': {
                    lines: 95,
                    functions: 95,
                    branches: 85,
                },
                'src/config/**': { lines: 85 },
                // P3 ground. Each of these went from near-zero; the floors
                // sit a few points under the measured value so a
                // timing-sensitive test flaking under load does not red the
                // build for a reason unrelated to coverage.
                'src/core/history.js': { lines: 90 },
                'src/core/nsfw.js': { lines: 80 },
                'src/core/thumbs.js': { lines: 72 },
                'src/core/accounts.js': { lines: 70 },
                'src/core/monitor.js': { lines: 57 },
                'src/core/downloader.js': { lines: 48 },
                'src/core/ai/scan-runner.js': { lines: 56 },
                // P4 ground — frontend page modules, all previously at 0%.
                'src/web/public/js/maintenance-cluster.js': { lines: 85 },
                'src/web/public/js/backfill.js': { lines: 74 },
                'src/web/public/js/maintenance-duplicates.js': { lines: 71 },
                'src/web/public/js/maintenance-thumbs.js': { lines: 70 },
                'src/web/public/js/maintenance-backup.js': { lines: 60 },
                'src/web/public/js/maintenance-nsfw.js': { lines: 64 },
                'src/web/public/js/queue.js': { lines: 93 },
            },
        },
    },
});
