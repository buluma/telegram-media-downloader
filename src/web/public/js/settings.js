import { api } from './api.js';
import { showToast } from './utils.js';

export async function loadSettings() {
    try {
        const config = await api.get('/api/config');
        
        // Populate inputs
        const bind = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val !== undefined ? val : '';
        };

        const dl = config.download || {};
        const rl = config.rateLimits || {};
        const dm = config.diskManagement || {};

        bind('setting-concurrent', dl.concurrent);
        document.getElementById('concurrent-value').textContent = dl.concurrent || 3;

        bind('setting-retries', dl.retries);
        document.getElementById('retries-value').textContent = dl.retries || 5;
        
        bind('setting-path', dl.path || './data/downloads');

        bind('setting-rpm', rl.requestsPerMinute);
        document.getElementById('rpm-value').textContent = rl.requestsPerMinute || 15;

        bind('setting-polling', config.pollingInterval);
        document.getElementById('polling-value').textContent = (config.pollingInterval || 10) + 's';

        // Max Speed
        const speedEl = document.getElementById('setting-max-speed');
        if (speedEl) {
            speedEl.value = dl.maxSpeed || 0;
            const speedLabel = document.getElementById('speed-value');
            if (speedLabel) {
                speedLabel.textContent = dl.maxSpeed ? (dl.maxSpeed / 1024 / 1024).toFixed(0) + ' MB/s' : 'Unlimited';
            }
        }

        bind('setting-max-disk', dm.maxTotalSize || '');
        bind('setting-max-video', dm.maxVideoSize || '');
        bind('setting-max-image', dm.maxImageSize || '');

    } catch (e) {
        console.error('Failed to load settings', e);
    }
}

export async function saveSettings() {
    const get = (id) => document.getElementById(id)?.value;

    const data = {
        download: {
            concurrent: parseInt(get('setting-concurrent')),
            retries: parseInt(get('setting-retries')),
            maxSpeed: parseInt(get('setting-max-speed')) || 0,
        },
        rateLimits: {
            requestsPerMinute: parseInt(get('setting-rpm'))
        },
        pollingInterval: parseInt(get('setting-polling')),
        diskManagement: {
            maxTotalSize: get('setting-max-disk') || null,
            maxVideoSize: get('setting-max-video') || null,
            maxImageSize: get('setting-max-image') || null
        }
    };

    try {
        await api.post('/api/config', data);
        showToast('Settings saved!', 'success');
    } catch (e) {
        showToast('Failed to save settings', 'error');
    }
}

export function applyPreset(type) {
    if (type === 'safe') {
        document.getElementById('setting-concurrent').value = 1;
        document.getElementById('setting-rpm').value = 5;
        document.getElementById('setting-polling').value = 30;
    } else if (type === 'balanced') {
        document.getElementById('setting-concurrent').value = 3;
        document.getElementById('setting-rpm').value = 15;
        document.getElementById('setting-polling').value = 10;
    } else if (type === 'fast') {
        document.getElementById('setting-concurrent').value = 5;
        document.getElementById('setting-rpm').value = 30;
        document.getElementById('setting-polling').value = 5;
    }
    
    // Trigger updates
    document.getElementById('setting-concurrent').dispatchEvent(new Event('input'));
    document.getElementById('setting-rpm').dispatchEvent(new Event('input'));
    document.getElementById('setting-polling').dispatchEvent(new Event('input'));
}
