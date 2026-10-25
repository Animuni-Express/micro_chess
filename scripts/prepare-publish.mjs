import { mkdir, copyFile, cp } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';

// Explicit allowlist: backend sources, migrations and local state never ship as assets.
await mkdir('dist', { recursive: true });
for (const entry of await readdir('.')) {
  if (/\.(html|css)$/.test(entry) || ['manifest.json','sw.js','_redirects'].includes(entry)) {
    await copyFile(entry,'dist/'+entry);
  }
}
for (const directory of ['public','pieces','icons']) await cp(directory,'dist/'+directory,{recursive:true});
