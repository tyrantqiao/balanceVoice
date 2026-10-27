import { readdir, readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve('extension');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
for (const file of await readdir(root)) {
  if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', path.join(root, file)]);
}
for (const file of [manifest.background.service_worker, manifest.action.default_popup, 'offscreen.html']) {
  await access(path.join(root, file));
}
for (const name of ['popup.html', 'offscreen.html']) {
  const html = await readFile(path.join(root, name), 'utf8');
  for (const [, tag, attribute, file] of html.matchAll(/<(\w+)\b[^>]*\b(src|href)="([^"]+)"/g)) {
    // Reference links open only on user click; scripts/styles remain bundled.
    if (tag.toLowerCase() === 'a' && attribute === 'href' && /^https:\/\//.test(file)) continue;
    if (/^https?:/.test(file)) throw new Error(`不允许远程依赖：${file}`);
    await access(path.join(root, file));
  }
}
if (manifest.manifest_version !== 3) throw new Error('需要 Manifest V3');
console.log('扩展脚本语法、manifest 和本地资源检查通过。');
