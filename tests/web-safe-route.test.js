import { describe, expect, it, vi } from 'vitest';
import { HttpError, makeSafe } from '../src/web/lib/safe-route.js';

function response() {
    return {
        headersSent: false,
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
    };
}

describe('safe route wrapper', () => {
    it('rejects non-function handlers at construction time', () => {
        expect(() => makeSafe()()).toThrow(/handler must be a function/);
    });

    it('passes successful synchronous handlers through', async () => {
        const res = response();
        const handler = vi.fn();

        await makeSafe({ prefix: 'test' })(handler)({ method: 'GET', url: '/ok' }, res, vi.fn());

        expect(handler).toHaveBeenCalledOnce();
        expect(res.status).not.toHaveBeenCalled();
    });

    it('turns async HttpErrors into structured responses and logs them', async () => {
        const res = response();
        const log = vi.fn();
        const req = { method: 'POST', originalUrl: '/api/test' };

        await makeSafe({ log, prefix: 'test' })(async () => {
            throw new HttpError(422, 'BAD_INPUT', 'Invalid input', { field: 'name' });
        })(req, res, vi.fn());

        expect(res.status).toHaveBeenCalledWith(422);
        expect(res.json).toHaveBeenCalledWith({
            ok: false,
            success: false,
            code: 'BAD_INPUT',
            message: 'Invalid input',
            where: 'POST /api/test',
            detail: { field: 'name' },
        });
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ source: 'test', level: 'error' }),
        );
    });

    it('does not write a second response after headers are sent', async () => {
        const res = response();
        res.headersSent = true;

        await makeSafe({ log: vi.fn() })(async () => {
            throw new Error('late failure');
        })({ method: 'GET', url: '/late' }, res, vi.fn());

        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
    });
});
