import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Small dependency-free ZIP writer (stored entries), for reproducible offline builds.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunks = [];
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const entries = [];
let offset = 0;
for (const file of (await readdir('extension')).sort()) {
  const data = await readFile(path.join('extension', file));
  const name = Buffer.from(file);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x21, 12); // 1980-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  chunks.push(local, name, data);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  entries.push(central, name);
  offset += local.length + name.length + data.length;
}
const directory = Buffer.concat(entries);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length / 2, 8);
end.writeUInt16LE(entries.length / 2, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
await mkdir('dist', { recursive: true });
const output = `dist/balance-voice-${manifest.version}.zip`;
await writeFile(output, Buffer.concat([...chunks, directory, end]));
console.log(`已生成 ${output}（解压后在 Chrome 加载）。`);
