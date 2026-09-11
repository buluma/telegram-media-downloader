import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
    'README.md',
    'CONTRIBUTING.md',
    'docs/AI.md',
    'docs/BACKUP.md',
    'docs/DEPLOY.md',
    'docs/TROUBLESHOOTING.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/ISSUE_TEMPLATE/bug.yml',
];

const forbidden = [/npm\s+(?:ci|test|start|install)\b/, /npm\s+run\b/, /docker compose exec app\b/];

const failures = [];
for (const relative of files) {
    const file = path.join(root, relative);
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
        if (pattern.test(source)) failures.push(`${relative}: found ${pattern}`);
    }
}

if (fs.existsSync(path.join(root, 'package-lock.json')))
    failures.push('package-lock.json must not be present');
if (fs.existsSync(path.join(root, 'pnpm-lock.yaml')))
    failures.push('pnpm-lock.yaml must not be present');

if (failures.length) {
    console.error('Documentation contract check failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}

console.log(`Documentation contract check passed (${files.length} files).`);
