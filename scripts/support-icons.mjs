import { readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises';

const root = new URL('../resources/icons/', import.meta.url);
const symbols = ['lock', 'lock_open_right', 'no_encryption'];
// Bundle composed SVGs so rendering needs neither filesystem reads nor background work.
for (const theme of ['light', 'dark', 'contrast', 'contrast-light']) {
  const folder = new URL(`${theme}/`, root);
  const output = new URL(`support/generated/${theme}/`, root);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const filename of await readdir(folder)) {
    const original = await readFile(new URL(filename, folder), 'utf8');
    const body = original.replace(/<svg[^>]*>/, '').replace('</svg>', '');
    for (const symbol of symbols) {
      const badge = (await readFile(new URL(`support/${symbol}.svg`, root), 'utf8'))
        .replace('<svg ', '<svg x="10" y="10" ').replace('height="24"', 'height="14"').replace('width="24"', 'width="14"');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><defs><mask id="support-cut"><rect width="24" height="24" fill="white"/><rect x="10" y="10" width="14" height="14" rx="2" fill="black"/></mask></defs><g mask="url(#support-cut)">${body}</g>${badge}</svg>\n`;
      await writeFile(new URL(filename.replace('.svg', `-${symbol}.svg`), output), svg);
    }
  }
}
