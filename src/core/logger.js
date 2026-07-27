export function wrapConsoleMethod(originalFn, label = 'gramjs', tee = null) {
    return function wrapped(...args) {
        const joined = args
            .map((a) =>
                a instanceof Error
                    ? a.stack || a.message
                    : typeof a === 'object'
                      ? safeStringify(a)
                      : String(a),
            )
            .join(' ');
        if (suppressNoise(joined, label)) return;
        if (tee) {
            try {
                tee(args, joined);
            } catch {
                /* never break the underlying console method */
            }
        }
        return originalFn.apply(console, args);
    };
}

function safeStringify(v) {
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}
export function suppressNoise(msg, label = 'gramjs') {
    if (!isNoise(msg)) return false;
    const text = typeof msg === 'string' ? msg : (msg && msg.message) || String(msg);
    logger.debug({ label, text }, 'GramJS noise suppressed');
    return true;
}

export function DebugLogger() {
    return {
        log: (filename, message, data = null) => {
            logger.info({ filename, data }, message);
        },
        error: (error, context = '') => {
            logger.error({ err: error, context }, error.message);
        },
    };
}
import pino from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '../../data/logs');

// Reuse one logger per process. Vitest hands each test file a fresh module
// registry but reuses the worker process, so without this the module body
// re-runs per file and builds another pino transport every time — each one
// a live worker thread holding app.log open, plus a `process.on('exit')`
// flush handler (which is what trips MaxListenersExceededWarning at 11).
// In production the module evaluates once and this is a no-op. Same
// globalThis-singleton idiom as GLOBAL_DB_KEY in src/core/db.js.
const GLOBAL_LOGGER_KEY = '__tgdl_logger__';

function buildLogger() {
    // Under test: no transport at all. The file target would write the whole
    // suite's output into data/logs/app.log, and pino-pretty would interleave
    // app WARN lines into the test report. Default to silent so runs stay
    // pristine; `LOG_LEVEL=debug npx vitest run` brings logs back (on stdout)
    // when debugging a failure.
    if (process.env.VITEST) {
        return pino({ level: process.env.LOG_LEVEL || 'silent' });
    }
    return pino({
        level: process.env.LOG_LEVEL || 'info',
        transport: {
            targets: [
                {
                    target: 'pino-pretty',
                    options: {
                        colorize: true,
                        translateTime: 'SYS:standard',
                    },
                },
                {
                    target: 'pino/file',
                    options: {
                        destination: path.join(LOG_DIR, 'app.log'),
                        mkdir: true,
                    },
                },
            ],
        },
    });
}

export const logger = (globalThis[GLOBAL_LOGGER_KEY] ??= buildLogger());

export const NATIVE_LOAD_FAIL =
    /(ld-linux|ld-musl|libonnxruntime|GLIBC_|NODE_MODULE_VERSION|cannot open shared object|Error loading shared library)/i;

// Keeping noise classifier for now to integrate into pino log processing
const NOISE_PATTERNS = [
    /\bNot connected\b/,
    /\bTIMEOUT\b/,
    /\bConnection closed\b/,
    /\bClosing current connection\b/,
    /\bReconnect\b/i,
    /\bdisconnect/i,
    /\bWebSocket connection failed\b/,
    /\bCHANNEL_INVALID\b/,
    /\bDisconnecting\b/,
    /\bRunning gramJS\b/,
];

export function isNoise(msg) {
    if (!msg) return false;
    const text = typeof msg === 'string' ? msg : (msg && msg.message) || String(msg);
    return NOISE_PATTERNS.some((re) => re.test(text));
}
