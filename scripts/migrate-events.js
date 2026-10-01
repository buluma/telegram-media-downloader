import fs from 'fs';

const dirs = [
    'src/web/public/index.html',
    'src/web/public/partials/groups.html',
    'src/web/public/partials/modals.html',
    'src/web/public/partials/settings.html',
    'src/web/public/js/pwa.js',
];

dirs.forEach((file) => {
    let content = fs.readFileSync(file, 'utf-8');

    // Simple mappings
    content = content.replace(/onclick="closeSidebar\(\)"/g, 'data-action="closeSidebar"');
    content = content.replace(/onclick="showAllMedia\(\)"/g, 'data-action="showAllMedia"');
    content = content.replace(
        /onclick="refreshCurrentPage\(\)"/g,
        'data-action="refreshCurrentPage"',
    );
    content = content.replace(
        /onclick="confirmDeleteFile\(\)"/g,
        'data-action="confirmDeleteFile"',
    );
    content = content.replace(
        /onclick="closeGroupSettings\(\)"/g,
        'data-action="closeGroupSettings"',
    );
    content = content.replace(
        /onclick="saveGroupSettings\(\)"/g,
        'data-action="saveGroupSettings"',
    );
    content = content.replace(
        /onclick="openDestinationPicker\(\)"/g,
        'data-action="openDestinationPicker"',
    );
    content = content.replace(/onclick="purgeAll\(\)"/g, 'data-action="purgeAll"');
    content = content.replace(/onclick="installPwa\(\)"/g, 'data-action="installPwa"');

    // With event arg
    content = content.replace(
        /onclick="toggleGroupEnabled\(event\)"/g,
        'data-action="toggleGroupEnabled"',
    );
    content = content.replace(
        /onclick="toggleFwdEnabled\(event\)"/g,
        'data-action="toggleFwdEnabled"',
    );
    content = content.replace(
        /onclick="toggleFwdDelete\(event\)"/g,
        'data-action="toggleFwdDelete"',
    );
    content = content.replace(
        /onclick="toggleFwdKeepImages\(event\)"/g,
        'data-action="toggleFwdKeepImages"',
    );
    content = content.replace(
        /onclick="toggleFwdKeepVideos\(event\)"/g,
        'data-action="toggleFwdKeepVideos"',
    );

    // With string arguments (navigateTo, switchGroupsTab, switchSettingsTab)
    content = content.replace(
        /onclick="navigateTo\('([^']+)'\)"/g,
        'data-action="navigateTo" data-arg="$1"',
    );
    content = content.replace(
        /onclick="switchGroupsTab\('([^']+)'\)"/g,
        'data-action="switchGroupsTab" data-arg="$1"',
    );
    content = content.replace(
        /onclick="switchSettingsTab\('([^']+)'\)"/g,
        'data-action="switchSettingsTab" data-arg="$1"',
    );

    fs.writeFileSync(file, content, 'utf-8');
});

// Update pwa.js to export registerAction
let pwaContent = fs.readFileSync('src/web/public/js/pwa.js', 'utf-8');
pwaContent = pwaContent.replace(
    /window\.installPwa = installPwa;/g,
    "import { registerAction } from './ui-events.js';\nregisterAction('installPwa', installPwa);",
);
fs.writeFileSync('src/web/public/js/pwa.js', pwaContent, 'utf-8');

console.log('Replaced onclick attributes');
