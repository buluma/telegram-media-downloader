// Route-level HTTP tests for /api/backup/*. This router is a thin HTTP
// shim over core/backup/index.js (the actual multi-provider mirror/
// snapshot engine — out of scope here, P3 territory), so that module
// is mocked wholesale and these tests only exercise id validation,
// status-code mapping, the structured log() calls, and the
// fire-and-forget /run early-return contract.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';

const backup = {
    listProviders: vi.fn(),
    listDestinations: vi.fn(),
    addDestination: vi.fn(),
    updateDestination: vi.fn(),
    removeDestination: vi.fn(),
    testConnection: vi.fn(),
    runBackup: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setEncryption: vi.fn(),
    unlockEncryption: vi.fn(),
    getDestinationStatus: vi.fn(),
    listJobs: vi.fn(),
    listRecent: vi.fn(),
    retryJob: vi.fn(),
};
vi.mock('../src/core/backup/index.js', () => backup);

let app;
let server;
let port;
let logs;

function apiUrl(p) {
    return `http://127.0.0.1:${port}${p}`;
}

beforeAll(async () => {
    const { createBackupRouter } = await import('../src/web/routes/backup.js');
    logs = [];
    app = express();
    app.use(express.json());
    app.use('/api', createBackupRouter({ log: (entry) => logs.push(entry) }));
    await new Promise((res) => {
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            res();
        });
    });
});

afterAll(async () => {
    await new Promise((res) => server.close(res));
});

beforeEach(() => {
    vi.clearAllMocks();
    logs.length = 0;
});

describe('GET /api/backup/providers', () => {
    it('returns the provider list', async () => {
        backup.listProviders.mockReturnValue(['s3', 'gdrive']);
        const res = await fetch(apiUrl('/api/backup/providers'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.providers).toEqual(['s3', 'gdrive']);
    });

    it('500s when listProviders throws', async () => {
        backup.listProviders.mockImplementation(() => {
            throw new Error('boom');
        });
        const res = await fetch(apiUrl('/api/backup/providers'));
        expect(res.status).toBe(500);
    });
});

describe('GET /api/backup/destinations', () => {
    it('returns the destination list', async () => {
        backup.listDestinations.mockReturnValue([{ id: 1 }]);
        const res = await fetch(apiUrl('/api/backup/destinations'));
        const body = await res.json();
        expect(body.destinations).toEqual([{ id: 1 }]);
    });

    it('500s when listDestinations throws', async () => {
        backup.listDestinations.mockImplementation(() => {
            throw new Error('boom');
        });
        const res = await fetch(apiUrl('/api/backup/destinations'));
        expect(res.status).toBe(500);
    });
});

describe('POST /api/backup/destinations', () => {
    it('creates a destination, logs it, and returns the created row', async () => {
        backup.addDestination.mockReturnValue(7);
        backup.listDestinations.mockReturnValue([{ id: 7, name: 'x' }]);
        const res = await fetch(apiUrl('/api/backup/destinations'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'x' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.id).toBe(7);
        expect(body.destination).toEqual({ id: 7, name: 'x' });
        expect(logs).toEqual([
            expect.objectContaining({
                source: 'backup',
                level: 'info',
                msg: 'destination created (#7)',
            }),
        ]);
    });

    it('400s and logs a warning when addDestination rejects', async () => {
        backup.addDestination.mockImplementation(() => {
            throw new Error('invalid config');
        });
        const res = await fetch(apiUrl('/api/backup/destinations'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
        expect(logs).toEqual([
            expect.objectContaining({
                level: 'warn',
                msg: 'destination create rejected: invalid config',
            }),
        ]);
    });

    it('passes an empty object when the request body is missing', async () => {
        backup.addDestination.mockReturnValue(1);
        backup.listDestinations.mockReturnValue([]);
        await fetch(apiUrl('/api/backup/destinations'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        expect(backup.addDestination).toHaveBeenCalledWith({});
    });
});

describe('id-validated destination routes', () => {
    const cases = [
        { method: 'PUT', path: '/api/backup/destinations/:id' },
        { method: 'DELETE', path: '/api/backup/destinations/:id' },
        { method: 'POST', path: '/api/backup/destinations/:id/test' },
        { method: 'POST', path: '/api/backup/destinations/:id/run' },
        { method: 'POST', path: '/api/backup/destinations/:id/pause' },
        { method: 'POST', path: '/api/backup/destinations/:id/resume' },
        { method: 'POST', path: '/api/backup/destinations/:id/encryption' },
        { method: 'POST', path: '/api/backup/destinations/:id/unlock' },
        { method: 'GET', path: '/api/backup/destinations/:id/status' },
        { method: 'GET', path: '/api/backup/destinations/:id/jobs' },
        { method: 'POST', path: '/api/backup/jobs/:id/retry' },
    ];

    for (const { method, path } of cases) {
        for (const badId of ['abc', '0', '-1']) {
            it(`${method} ${path} 400s for id=${badId}`, async () => {
                const url = path.replace(':id', badId);
                const res = await fetch(apiUrl(url), {
                    method,
                    headers: { 'Content-Type': 'application/json' },
                });
                expect(res.status).toBe(400);
                const body = await res.json();
                expect(body.error).toBe('bad id');
            });
        }
    }
});

describe('PUT /api/backup/destinations/:id', () => {
    it('updates and logs on success', async () => {
        backup.updateDestination.mockReturnValue({ id: 3, name: 'renamed' });
        const res = await fetch(apiUrl('/api/backup/destinations/3'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'renamed' }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.destination).toEqual({ id: 3, name: 'renamed' });
        expect(logs[0].msg).toBe('destination updated (#3)');
    });

    it('400s when updateDestination throws', async () => {
        backup.updateDestination.mockImplementation(() => {
            throw new Error('not found');
        });
        const res = await fetch(apiUrl('/api/backup/destinations/3'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });
});

describe('DELETE /api/backup/destinations/:id', () => {
    it('removes and logs regardless of the returned ok value', async () => {
        backup.removeDestination.mockReturnValue(true);
        const res = await fetch(apiUrl('/api/backup/destinations/3'), { method: 'DELETE' });
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(logs[0].msg).toBe('destination removed (#3)');
    });

    it('500s when removeDestination throws', async () => {
        backup.removeDestination.mockImplementation(() => {
            throw new Error('db error');
        });
        const res = await fetch(apiUrl('/api/backup/destinations/3'), { method: 'DELETE' });
        expect(res.status).toBe(500);
    });
});

describe('POST /api/backup/destinations/:id/test', () => {
    it('logs at info level and 200s when the connection test succeeds', async () => {
        backup.testConnection.mockResolvedValue({ ok: true, detail: 'reachable' });
        const res = await fetch(apiUrl('/api/backup/destinations/3/test'), { method: 'POST' });
        expect(res.status).toBe(200);
        expect(logs[0]).toEqual(
            expect.objectContaining({ level: 'info', msg: 'test connection on #3: reachable' }),
        );
    });

    it('logs at warn level when the connection test fails, using "failed" with no detail', async () => {
        backup.testConnection.mockResolvedValue({ ok: false });
        await fetch(apiUrl('/api/backup/destinations/3/test'), { method: 'POST' });
        expect(logs[0]).toEqual(
            expect.objectContaining({ level: 'warn', msg: 'test connection on #3: failed' }),
        );
    });

    it('500s when testConnection rejects', async () => {
        backup.testConnection.mockRejectedValue(new Error('timeout'));
        const res = await fetch(apiUrl('/api/backup/destinations/3/test'), { method: 'POST' });
        expect(res.status).toBe(500);
    });
});

describe('POST /api/backup/destinations/:id/run', () => {
    it('returns success:true, started:true immediately without waiting on the backup to finish', async () => {
        let resolveRun;
        backup.runBackup.mockReturnValue(new Promise((r) => (resolveRun = r)));
        const res = await fetch(apiUrl('/api/backup/destinations/3/run'), { method: 'POST' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ success: true, started: true });
        resolveRun();
    });

    it('logs an error entry (does not crash) when the background run rejects', async () => {
        backup.runBackup.mockRejectedValue(new Error('upload failed'));
        const res = await fetch(apiUrl('/api/backup/destinations/3/run'), { method: 'POST' });
        expect(res.status).toBe(200);
        await vi.waitFor(() =>
            expect(logs).toEqual([
                expect.objectContaining({
                    level: 'error',
                    msg: 'run failed for #3: upload failed',
                }),
            ]),
        );
    });

    it('400s when runBackup throws synchronously (bad state)', async () => {
        backup.runBackup.mockImplementation(() => {
            throw new Error('already running');
        });
        const res = await fetch(apiUrl('/api/backup/destinations/3/run'), { method: 'POST' });
        expect(res.status).toBe(400);
    });
});

describe('POST /api/backup/destinations/:id/pause and /resume', () => {
    it('pauses and logs', async () => {
        const res = await fetch(apiUrl('/api/backup/destinations/3/pause'), { method: 'POST' });
        expect(res.status).toBe(200);
        expect(backup.pause).toHaveBeenCalledWith(3);
        expect(logs[0].msg).toBe('paused #3');
    });

    it('500s when pause throws', async () => {
        backup.pause.mockImplementation(() => {
            throw new Error('boom');
        });
        const res = await fetch(apiUrl('/api/backup/destinations/3/pause'), { method: 'POST' });
        expect(res.status).toBe(500);
    });

    it('resumes and logs', async () => {
        const res = await fetch(apiUrl('/api/backup/destinations/3/resume'), { method: 'POST' });
        expect(res.status).toBe(200);
        expect(backup.resume).toHaveBeenCalledWith(3);
        expect(logs[0].msg).toBe('resumed #3');
    });

    it('500s when resume throws', async () => {
        backup.resume.mockImplementation(() => {
            throw new Error('boom');
        });
        const res = await fetch(apiUrl('/api/backup/destinations/3/resume'), { method: 'POST' });
        expect(res.status).toBe(500);
    });
});

describe('POST /api/backup/destinations/:id/encryption', () => {
    it('coerces enabled to a boolean and passes the passphrase through', async () => {
        backup.setEncryption.mockReturnValue({ id: 3, encrypted: true });
        const res = await fetch(apiUrl('/api/backup/destinations/3/encryption'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: 'yes', passphrase: 'hunter2' }),
        });
        expect(res.status).toBe(200);
        expect(backup.setEncryption).toHaveBeenCalledWith(3, {
            enabled: true,
            passphrase: 'hunter2',
        });
    });

    it('400s when setEncryption throws', async () => {
        backup.setEncryption.mockImplementation(() => {
            throw new Error('weak passphrase');
        });
        const res = await fetch(apiUrl('/api/backup/destinations/3/encryption'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
    });
});

describe('POST /api/backup/destinations/:id/unlock', () => {
    it('defaults to an empty passphrase when none is given', async () => {
        const res = await fetch(apiUrl('/api/backup/destinations/3/unlock'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        expect(res.status).toBe(200);
        expect(backup.unlockEncryption).toHaveBeenCalledWith(3, '');
    });

    it('400s when unlockEncryption throws (wrong passphrase)', async () => {
        backup.unlockEncryption.mockImplementation(() => {
            throw new Error('wrong passphrase');
        });
        const res = await fetch(apiUrl('/api/backup/destinations/3/unlock'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passphrase: 'wrong' }),
        });
        expect(res.status).toBe(400);
    });
});

describe('GET /api/backup/status', () => {
    it('reports running:true when any scrubbed destination is running', async () => {
        backup.listDestinations.mockReturnValue([{ id: 1 }, { id: 2 }]);
        backup.getDestinationStatus.mockImplementation((id) => ({ running: id === 2 }));
        const res = await fetch(apiUrl('/api/backup/status'));
        const body = await res.json();
        expect(body.running).toBe(true);
        expect(backup.listDestinations).toHaveBeenCalledWith({ scrubbed: true });
    });

    it('reports running:false when nothing is running', async () => {
        backup.listDestinations.mockReturnValue([{ id: 1 }]);
        backup.getDestinationStatus.mockReturnValue({ running: false });
        const res = await fetch(apiUrl('/api/backup/status'));
        const body = await res.json();
        expect(body.running).toBe(false);
    });

    it('treats a per-destination status failure as not-running rather than crashing the whole endpoint', async () => {
        backup.listDestinations.mockReturnValue([{ id: 1 }, { id: 2 }]);
        backup.getDestinationStatus.mockImplementation((id) => {
            if (id === 1) throw new Error('disconnected');
            return { running: true };
        });
        const res = await fetch(apiUrl('/api/backup/status'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.running).toBe(true);
    });

    it('500s when listDestinations itself throws', async () => {
        backup.listDestinations.mockImplementation(() => {
            throw new Error('boom');
        });
        const res = await fetch(apiUrl('/api/backup/status'));
        expect(res.status).toBe(500);
    });
});

describe('GET /api/backup/destinations/:id/status', () => {
    it('returns the destination status', async () => {
        backup.getDestinationStatus.mockReturnValue({ running: true, lastRunAt: 123 });
        const res = await fetch(apiUrl('/api/backup/destinations/3/status'));
        const body = await res.json();
        expect(body.running).toBe(true);
        expect(body.lastRunAt).toBe(123);
    });

    it('404s when getDestinationStatus throws', async () => {
        backup.getDestinationStatus.mockImplementation(() => {
            throw new Error('not found');
        });
        const res = await fetch(apiUrl('/api/backup/destinations/3/status'));
        expect(res.status).toBe(404);
    });
});

describe('GET /api/backup/destinations/:id/jobs', () => {
    it('passes status/limit/offset through with defaults applied', async () => {
        backup.listJobs.mockReturnValue([{ id: 1 }]);
        await fetch(apiUrl('/api/backup/destinations/3/jobs'));
        expect(backup.listJobs).toHaveBeenCalledWith({
            destinationId: 3,
            status: null,
            limit: 50,
            offset: 0,
        });
    });

    it('passes through an explicit status/limit/offset', async () => {
        backup.listJobs.mockReturnValue([]);
        await fetch(apiUrl('/api/backup/destinations/3/jobs?status=failed&limit=10&offset=5'));
        expect(backup.listJobs).toHaveBeenCalledWith({
            destinationId: 3,
            status: 'failed',
            limit: 10,
            offset: 5,
        });
    });

    it('clamps limit to 500 and offset to a floor of 0', async () => {
        backup.listJobs.mockReturnValue([]);
        await fetch(apiUrl('/api/backup/destinations/3/jobs?limit=99999&offset=-5'));
        expect(backup.listJobs).toHaveBeenCalledWith(
            expect.objectContaining({ limit: 500, offset: 0 }),
        );
    });

    it('500s when listJobs throws', async () => {
        backup.listJobs.mockImplementation(() => {
            throw new Error('boom');
        });
        const res = await fetch(apiUrl('/api/backup/destinations/3/jobs'));
        expect(res.status).toBe(500);
    });
});

describe('GET /api/backup/jobs/recent', () => {
    it('defaults the limit to 20', async () => {
        backup.listRecent.mockReturnValue([]);
        await fetch(apiUrl('/api/backup/jobs/recent'));
        expect(backup.listRecent).toHaveBeenCalledWith(20);
    });

    it('clamps the limit to a ceiling of 200', async () => {
        backup.listRecent.mockReturnValue([]);
        await fetch(apiUrl('/api/backup/jobs/recent?limit=99999'));
        expect(backup.listRecent).toHaveBeenCalledWith(200);
    });

    it('500s when listRecent throws', async () => {
        backup.listRecent.mockImplementation(() => {
            throw new Error('boom');
        });
        const res = await fetch(apiUrl('/api/backup/jobs/recent'));
        expect(res.status).toBe(500);
    });
});

describe('POST /api/backup/jobs/:id/retry', () => {
    it('logs only when the retry actually succeeds', async () => {
        backup.retryJob.mockReturnValue(true);
        const res = await fetch(apiUrl('/api/backup/jobs/9/retry'), { method: 'POST' });
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(logs).toHaveLength(1);
        expect(logs[0].msg).toBe('manual retry on job #9');
    });

    it('does not log when the retry is a no-op (job not found/not failed)', async () => {
        backup.retryJob.mockReturnValue(false);
        const res = await fetch(apiUrl('/api/backup/jobs/9/retry'), { method: 'POST' });
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(logs).toHaveLength(0);
    });

    it('500s when retryJob throws', async () => {
        backup.retryJob.mockImplementation(() => {
            throw new Error('boom');
        });
        const res = await fetch(apiUrl('/api/backup/jobs/9/retry'), { method: 'POST' });
        expect(res.status).toBe(500);
    });
});
