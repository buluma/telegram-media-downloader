module.exports = {
    apps: [
        {
            name: 'tgdl',
            script: 'scripts/run-node.js',
            args: 'src/index.js',
            interpreter: 'node',

            // Restart policy — mirrors runner.js behaviour but delegates
            // crash counting to PM2 so we don't need the watchdog wrapper.
            max_restarts: 10,
            min_uptime: '10s',
            restart_delay: 2000,

            // Keep stdout/stderr in data/logs alongside the app's own logs.
            out_file: 'data/logs/pm2-out.log',
            error_file: 'data/logs/pm2-err.log',
            merge_logs: true,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',

            // ESM — no transpilation needed, node handles it natively.
            node_args: [],

            // Expose PORT if you want a non-default dashboard port.
            env: {
                NODE_ENV: 'production',
                PORT: 3000,
            },

            // Example: override PORT for a staging instance.
            env_staging: {
                NODE_ENV: 'production',
                PORT: 3001,
            },
        },
    ],
};
