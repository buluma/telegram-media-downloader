const actions = new Map();

/**
 * Register a function to handle UI clicks.
 * @param {string} name - The data-action name
 * @param {Function} fn - The handler function
 */
export function registerAction(name, fn) {
    actions.set(name, fn);
}

document.body.addEventListener('click', (e) => {
    // Traverse up to find the closest element with a data-action attribute
    const el = e.target.closest('[data-action]');
    if (!el) return;

    const action = el.getAttribute('data-action');
    const fn = actions.get(action);

    if (fn) {
        const arg = el.getAttribute('data-arg');
        if (arg !== null) {
            fn(arg, e, el);
        } else {
            fn(e, el);
        }
    }
});
