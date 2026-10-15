// Predeploy: copy the browser's geometry/model helpers into functions/shared, so the function describes surfaces
// with exactly the same maths the player uses.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'shared');
fs.mkdirSync(out, { recursive: true });
for (const f of ['geometry.js', 'model.js']) fs.copyFileSync(path.join(here, '..', 'js', f), path.join(out, f));
console.log('Copied shared helpers to functions/shared');
