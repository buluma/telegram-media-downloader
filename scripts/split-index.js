import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(__dirname, '../src/web/public/index.html');
const partialsDir = path.join(__dirname, '../src/web/public/partials');
let html = fs.readFileSync(indexPath, 'utf8');

const pages = [
    'page-viewer',
    'page-groups',
    'page-settings',
    'page-backfill',
    'page-queue',
    'page-maintenance',
    'page-maintenance-duplicates',
    'page-maintenance-thumbs',
    'page-maintenance-seekbar',
    'page-maintenance-video',
    'page-maintenance-nsfw',
    'page-maintenance-ai',
    'page-maintenance-logs',
    'page-maintenance-backup',
    'page-maintenance-cluster',
    'page-maintenance-recovery',
    'page-maintenance-db-stats',
    'page-maintenance-updates',
];

function extractBlockRegex(htmlStr, divId) {
    const startStr = `<div id="${divId}"`;
    const startIndex = htmlStr.indexOf(startStr);
    if (startIndex === -1) return null;

    // Blank out comments so we don't parse `<div` or `</div` inside them,
    // preserving exact string indices.
    let cleanHtml = htmlStr.replace(/<!--[\s\S]*?-->/g, (match) => ' '.repeat(match.length));

    let depth = 0;
    let i = startIndex;
    while (i < cleanHtml.length) {
        if (cleanHtml.startsWith('<div', i)) {
            depth++;
            i += 4;
        } else if (cleanHtml.startsWith('</div', i)) {
            depth--;
            i += 5;
            if (depth === 0) {
                const endIndex = cleanHtml.indexOf('>', i) + 1;
                return {
                    content: htmlStr.substring(startIndex, endIndex),
                    startIndex: startIndex,
                    endIndex: endIndex,
                };
            }
        } else {
            i++;
        }
    }
    return null;
}

for (const page of pages) {
    const block = extractBlockRegex(html, page);
    if (block) {
        let wsStart = block.startIndex;
        while (wsStart > 0 && (html[wsStart - 1] === ' ' || html[wsStart - 1] === '\t')) {
            wsStart--;
        }

        let pad = html.substring(wsStart, block.startIndex);
        let partialName = page.replace('page-', '') + '.html';

        fs.writeFileSync(path.join(partialsDir, partialName), block.content);
        html =
            html.substring(0, wsStart) +
            pad +
            `<!-- INCLUDE: partials/${partialName} -->` +
            html.substring(block.endIndex);
    }
}

// Extract modals
const modalIds = ['modal-overlay', 'media-modal', 'prompt-modal', 'group-modal', 'toast-container'];
let modalsContent = '';

for (const modalId of modalIds) {
    const modalBlock = extractBlockRegex(html, modalId);
    if (modalBlock) {
        let wsStart = modalBlock.startIndex;
        while (wsStart > 0 && (html[wsStart - 1] === ' ' || html[wsStart - 1] === '\t')) wsStart--;

        modalsContent += modalBlock.content + '\n\n';
        html = html.substring(0, wsStart) + html.substring(modalBlock.endIndex);
    }
}

if (modalsContent) {
    fs.writeFileSync(path.join(partialsDir, 'modals.html'), modalsContent);
    // Put it right before </body>
    html = html.replace('</body>', '    <!-- INCLUDE: partials/modals.html -->\n</body>');
}

// Extract template tags
let templatesHtml = '';
while (true) {
    const startIdx = html.indexOf('<template');
    if (startIdx === -1) break;
    const endIdx = html.indexOf('</template>', startIdx) + 11;
    templatesHtml += html.substring(startIdx, endIdx) + '\n\n';

    let wsStart = startIdx;
    while (
        wsStart > 0 &&
        (html[wsStart - 1] === ' ' || html[wsStart - 1] === '\t' || html[wsStart - 1] === '\n')
    ) {
        wsStart--;
    }

    html = html.substring(0, wsStart) + '\n' + html.substring(endIdx);
}
if (templatesHtml) {
    fs.writeFileSync(path.join(partialsDir, 'templates.html'), templatesHtml.trim() + '\n');
    html = html.replace('</body>', '    <!-- INCLUDE: partials/templates.html -->\n</body>');
}

fs.writeFileSync(indexPath, html);
console.log('Split complete!');
