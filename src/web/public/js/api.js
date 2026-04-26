// API wrapper.
// - Surfaces server-side error messages (response body) instead of "HTTP 4xx".
// - Redirects to /login.html on 401 so an expired session never leaves the
//   SPA stuck on a generic error toast.
// - Treats 503 with setupRequired:true as a redirect to /setup-needed.html.

async function parseJsonSafe(res) {
    const text = await res.text();
    try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

async function request(method, url, body) {
    const init = { method };
    if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);

    if (res.status === 401) {
        // Skip the redirect for the auth-check itself so login.html doesn't loop.
        if (!url.startsWith('/api/auth_check') && !url.startsWith('/api/login')) {
            window.location.href = '/login.html';
        }
        const data = await parseJsonSafe(res);
        const err = new Error(data.error || 'Unauthorized');
        err.status = 401;
        err.data = data;
        throw err;
    }

    const data = await parseJsonSafe(res);

    if (res.status === 503 && data.setupRequired && !window.location.pathname.startsWith('/setup-needed')) {
        window.location.href = '/setup-needed.html';
        const err = new Error(data.error || 'Setup required');
        err.status = 503;
        throw err;
    }

    if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
    }

    return data;
}

export const api = {
    get: (url) => request('GET', url),
    post: (url, data) => request('POST', url, data),
    put: (url, data) => request('PUT', url, data),
    delete: (url, data) => request('DELETE', url, data),
};
