// Container healthcheck. /api/auth_check is unauthenticated and always
// returns 200 with the auth state, so it doubles as a liveness probe. Exits
// 0 on a good response within 8 seconds, 1 otherwise — Docker's HEALTHCHECK
// uses the exit code.
//
// Was 4000ms — too tight for a Pi-class host under a legitimate but
// transient CPU spike (e.g. a concurrent docker build): 2026-07-03 saw
// auth_check take 3.6s while genuinely alive, just slow, close enough to
// 4s that a routine load spike alone could trip a false-positive restart.
// Bumped to 8s; docker-compose.yml's healthcheck.timeout (and the
// Dockerfile HEALTHCHECK's --timeout, for non-compose runs) must stay
// above this value or Docker kills the check process before this
// timeout ever fires.

import http from 'http';

const port = process.env.PORT || 3000;
const req = http.request(
    { host: '127.0.0.1', port, path: '/api/auth_check', method: 'GET', timeout: 8000 },
    (res) => {
        res.resume();
        process.exit(res.statusCode === 200 ? 0 : 1);
    },
);
req.on('error', () => process.exit(1));
req.on('timeout', () => {
    req.destroy();
    process.exit(1);
});
req.end();
