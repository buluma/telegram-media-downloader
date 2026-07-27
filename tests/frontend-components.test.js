// @vitest-environment jsdom
//
// Covers src/web/public/js/components.js — pure HTML-string builders
// (chat row, empty state, gallery/row skeletons). No DOM side effects,
// so tests parse the returned markup with a scratch <template> instead
// of mocking anything. utils.js (createAvatar/escapeHtml/formatRelativeTime)
// runs for real since it's pure and exercising the real escaping path
// matters for the XSS checks below.

import { describe, it, expect } from 'vitest';
import {
    renderChatRow,
    renderEmptyState,
    renderGallerySkeletons,
    renderRowSkeletons,
} from '../src/web/public/js/components.js';

function parse(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
}

describe('renderChatRow', () => {
    it('renders the name and marks the row selected', () => {
        const el = parse(
            renderChatRow({ id: '1', name: 'Alice', avatarType: 'user', selected: true }),
        );
        expect(el.classList.contains('is-selected')).toBe(true);
        expect(el.getAttribute('aria-current')).toBe('true');
        expect(el.querySelector('.row-title-name').textContent).toBe('Alice');
    });

    it('falls back to id for the title when name is missing', () => {
        const el = parse(renderChatRow({ id: '42', avatarType: 'user' }));
        expect(el.querySelector('.row-title-name').textContent).toBe('42');
    });

    it('omits the subtitle element entirely when there is none', () => {
        const el = parse(renderChatRow({ id: '1', name: 'A', avatarType: 'user' }));
        expect(el.querySelector('.row-subtitle')).toBeNull();
    });

    it('renders the subtitle when given', () => {
        const el = parse(
            renderChatRow({ id: '1', name: 'A', subtitle: 'last seen', avatarType: 'user' }),
        );
        expect(el.querySelector('.row-subtitle').textContent).toBe('last seen');
    });

    it('derives the time meta from lastDownloadAt when time is not given', () => {
        const el = parse(
            renderChatRow({ id: '1', name: 'A', avatarType: 'user', lastDownloadAt: Date.now() }),
        );
        expect(el.querySelector('.row-meta span').textContent).toBe('now');
    });

    it('an explicit time wins over lastDownloadAt', () => {
        const el = parse(
            renderChatRow({
                id: '1',
                name: 'A',
                avatarType: 'user',
                time: '5m',
                lastDownloadAt: Date.now() - 999999,
            }),
        );
        expect(el.querySelector('.row-meta span').textContent).toBe('5m');
    });

    it('omits the meta wrapper entirely with nothing to show', () => {
        const el = parse(renderChatRow({ id: '1', name: 'A', avatarType: 'user' }));
        expect(el.querySelector('.row-meta')).toBeNull();
    });

    it('renders a status pill with its kind class', () => {
        const el = parse(
            renderChatRow({
                id: '1',
                name: 'A',
                avatarType: 'user',
                statusPill: { label: 'Paused', kind: 'paused' },
            }),
        );
        const pill = el.querySelector('.status-pill');
        expect(pill.className).toContain('status-pill-paused');
        expect(pill.textContent).toBe('Paused');
    });

    it('defaults the status pill kind to "add" when not given', () => {
        const el = parse(
            renderChatRow({ id: '1', name: 'A', avatarType: 'user', statusPill: { label: 'x' } }),
        );
        expect(el.querySelector('.status-pill').className).toContain('status-pill-add');
    });

    it('shows the unread badge for a non-zero count', () => {
        const el = parse(renderChatRow({ id: '1', name: 'A', avatarType: 'user', unread: 3 }));
        expect(el.querySelector('.unread-pill').textContent).toBe('3');
        expect(el.querySelector('.unread-pill').classList.contains('muted')).toBe(false);
    });

    it('hides the unread badge when the count is exactly 0', () => {
        const el = parse(renderChatRow({ id: '1', name: 'A', avatarType: 'user', unread: 0 }));
        expect(el.querySelector('.unread-pill')).toBeNull();
    });

    it('marks the unread badge muted when requested', () => {
        const el = parse(
            renderChatRow({ id: '1', name: 'A', avatarType: 'user', unread: 2, unreadMuted: true }),
        );
        expect(el.querySelector('.unread-pill').classList.contains('muted')).toBe(true);
    });

    it('renders the monitor button in the "enabled" state', () => {
        const el = parse(
            renderChatRow({ id: '1', name: 'A', avatarType: 'user', monitorEnabled: true }),
        );
        const btn = el.querySelector('.chat-row-monitor');
        expect(btn.dataset.current).toBe('1');
        expect(btn.querySelector('i').className).toContain('ri-pause-circle-line');
    });

    it('renders the monitor button in the "disabled" state', () => {
        const el = parse(
            renderChatRow({ id: '1', name: 'A', avatarType: 'user', monitorEnabled: false }),
        );
        const btn = el.querySelector('.chat-row-monitor');
        expect(btn.dataset.current).toBe('0');
        expect(btn.querySelector('i').className).toContain('ri-play-circle-line');
    });

    it('omits the monitor button entirely when monitorEnabled is null', () => {
        const el = parse(renderChatRow({ id: '1', name: 'A', avatarType: 'user' }));
        expect(el.querySelector('.chat-row-monitor')).toBeNull();
    });

    it('renders the cog button only when cog is true', () => {
        const withCog = parse(renderChatRow({ id: '1', name: 'A', avatarType: 'user', cog: true }));
        const withoutCog = parse(renderChatRow({ id: '1', name: 'A', avatarType: 'user' }));
        expect(withCog.querySelector('.chat-row-cog')).not.toBeNull();
        expect(withoutCog.querySelector('.chat-row-cog')).toBeNull();
    });

    it('merges peerId/peerName into the dataset attrs for a federated row', () => {
        // Attribute names are written as data-peerId/data-peerName (camelCase),
        // which HTML parsing lowercases to data-peerid/data-peername — so the
        // resulting dataset keys are lowercase too, not the camelCase DOM
        // convention a hand-written `data-peer-id` attribute would give.
        const el = parse(
            renderChatRow({
                id: '1',
                name: 'A',
                avatarType: 'user',
                peerId: '99',
                peerName: 'Bob',
            }),
        );
        expect(el.getAttribute('data-peerid')).toBe('99');
        expect(el.getAttribute('data-peername')).toBe('Bob');
    });

    it('omits peerName from the dataset when not given, even with a peerId', () => {
        const el = parse(renderChatRow({ id: '1', name: 'A', avatarType: 'user', peerId: '99' }));
        expect(el.getAttribute('data-peerid')).toBe('99');
        expect(el.hasAttribute('data-peername')).toBe(false);
    });

    it('drops undefined/null values from the dataset attrs', () => {
        const el = parse(
            renderChatRow({
                id: '1',
                name: 'A',
                avatarType: 'user',
                data: { extra: undefined, keep: 'x' },
            }),
        );
        expect('extra' in el.dataset).toBe(false);
        expect(el.dataset.keep).toBe('x');
    });

    it('renders one chip per accountChips entry with escaped label/title', () => {
        const el = parse(
            renderChatRow({
                id: '1',
                name: 'A',
                avatarType: 'user',
                accountChips: [
                    { id: 'acc1', label: '<b>Acc1</b>' },
                    { id: 'acc2', label: 'Acc2', title: 'Full title' },
                ],
            }),
        );
        const chips = el.querySelectorAll('.account-chip');
        expect(chips).toHaveLength(2);
        expect(chips[0].querySelector('b')).toBeNull();
        expect(chips[0].textContent).toBe('<b>Acc1</b>');
        expect(chips[1].getAttribute('title')).toBe('Full title');
    });

    it('falls back to the chip id as its own label/title when neither is given', () => {
        const el = parse(
            renderChatRow({
                id: '1',
                name: 'A',
                avatarType: 'user',
                accountChips: [{ id: 'acc1' }],
            }),
        );
        const chip = el.querySelector('.account-chip');
        expect(chip.textContent).toBe('acc1');
        expect(chip.getAttribute('title')).toBe('acc1');
    });

    it('omits the chips wrapper entirely with an empty accountChips array', () => {
        const el = parse(
            renderChatRow({ id: '1', name: 'A', avatarType: 'user', accountChips: [] }),
        );
        expect(el.querySelector('.row-account-chips')).toBeNull();
    });

    it('gives the same account id a stable chip hue across renders', () => {
        const first = parse(
            renderChatRow({
                id: '1',
                name: 'A',
                avatarType: 'user',
                accountChips: [{ id: 'stable-acc' }],
            }),
        );
        const second = parse(
            renderChatRow({
                id: '2',
                name: 'B',
                avatarType: 'user',
                accountChips: [{ id: 'stable-acc' }],
            }),
        );
        expect(first.querySelector('.account-chip').getAttribute('style')).toBe(
            second.querySelector('.account-chip').getAttribute('style'),
        );
    });

    it('escapes a hostile name/subtitle instead of injecting markup', () => {
        // Scoped to the name/subtitle containers specifically — the
        // avatar itself always renders a real <img> for the photo, so
        // querying the whole row for "img" would false-positive.
        const el = parse(
            renderChatRow({
                id: '1',
                name: '<img src=x onerror=alert(1)>',
                subtitle: '<script>evil()</script>',
                avatarType: 'user',
            }),
        );
        expect(el.querySelector('.row-title-name').querySelector('img')).toBeNull();
        expect(el.querySelector('.row-subtitle').querySelector('script')).toBeNull();
        expect(el.querySelector('.row-title-name').textContent).toBe(
            '<img src=x onerror=alert(1)>',
        );
        expect(el.querySelector('.row-subtitle').textContent).toBe('<script>evil()</script>');
    });
});

describe('renderEmptyState', () => {
    it('renders the icon and title', () => {
        const el = parse(renderEmptyState({ icon: 'ri-image-line', title: 'No media yet' }));
        expect(el.querySelector('i').className).toContain('ri-image-line');
        expect(el.querySelector('h3').textContent).toBe('No media yet');
    });

    it('defaults the icon and title when not given', () => {
        const el = parse(renderEmptyState());
        expect(el.querySelector('i').className).toContain('ri-information-line');
        expect(el.querySelector('h3').textContent).toBe('');
    });

    it('omits the body paragraph when none is given', () => {
        const el = parse(renderEmptyState({ title: 'x' }));
        expect(el.querySelector('p')).toBeNull();
    });

    it('renders the body paragraph when given', () => {
        const el = parse(renderEmptyState({ title: 'x', body: 'Pick a chat.' }));
        expect(el.querySelector('p').textContent).toBe('Pick a chat.');
    });

    it('renders a link action when actionHref is given', () => {
        const el = parse(
            renderEmptyState({ title: 'x', actionLabel: 'Browse chats', actionHref: '#/groups' }),
        );
        const a = el.querySelector('a.tg-btn');
        expect(a.getAttribute('href')).toBe('#/groups');
        expect(a.textContent).toContain('Browse chats');
        expect(el.querySelector('button')).toBeNull();
    });

    it('renders a button action when only actionLabel is given', () => {
        const el = parse(renderEmptyState({ title: 'x', actionLabel: 'Retry' }));
        const btn = el.querySelector('button.tg-btn');
        expect(btn.id).toBe('empty-cta');
        expect(btn.textContent).toContain('Retry');
        expect(el.querySelector('a')).toBeNull();
    });

    it('uses a custom actionId for the button when given', () => {
        const el = parse(
            renderEmptyState({ title: 'x', actionLabel: 'Retry', actionId: 'my-cta' }),
        );
        expect(el.querySelector('button').id).toBe('my-cta');
    });

    it('omits the action entirely without an actionLabel', () => {
        const el = parse(renderEmptyState({ title: 'x' }));
        expect(el.querySelector('a')).toBeNull();
        expect(el.querySelector('button')).toBeNull();
    });

    it('escapes a hostile title/body/icon', () => {
        const el = parse(
            renderEmptyState({
                icon: '"><img src=x onerror=alert(1)>',
                title: '<script>evil()</script>',
                body: '<b>bold</b>',
            }),
        );
        expect(el.querySelector('img')).toBeNull();
        expect(el.querySelector('script')).toBeNull();
        expect(el.querySelector('b')).toBeNull();
    });
});

describe('renderGallerySkeletons', () => {
    it('renders 12 tiles by default', () => {
        const wrap = document.createElement('div');
        wrap.innerHTML = renderGallerySkeletons();
        expect(wrap.querySelectorAll('.skeleton')).toHaveLength(12);
    });

    it('renders the requested count', () => {
        const wrap = document.createElement('div');
        wrap.innerHTML = renderGallerySkeletons(3);
        expect(wrap.querySelectorAll('.skeleton')).toHaveLength(3);
    });

    it('renders nothing for a count of 0', () => {
        const wrap = document.createElement('div');
        wrap.innerHTML = renderGallerySkeletons(0);
        expect(wrap.querySelectorAll('.skeleton')).toHaveLength(0);
    });
});

describe('renderRowSkeletons', () => {
    it('renders 6 rows by default, each with two skeleton bars', () => {
        const wrap = document.createElement('div');
        wrap.innerHTML = renderRowSkeletons();
        expect(wrap.querySelectorAll('.chat-row')).toHaveLength(6);
        expect(wrap.querySelectorAll('.chat-row .skeleton')).toHaveLength(6 * 3);
    });

    it('renders the requested count', () => {
        const wrap = document.createElement('div');
        wrap.innerHTML = renderRowSkeletons(2);
        expect(wrap.querySelectorAll('.chat-row')).toHaveLength(2);
    });
});
