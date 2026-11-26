import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../packages/web/public/vendor/xspreadsheet/xspreadsheet.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

console.log('at-rules:', [...css.matchAll(/@[a-z-]+/g)].map((m) => m[0]).join(',') || '(none)');

const COLOR_PROPS =
  /^(color|background|background-color|border|border-color|border-top-color|border-bottom-color|border-left-color|border-right-color|border-top|border-bottom|border-left|border-right|box-shadow|outline-color|fill|stroke)$/;
const LIT = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

const lines = [];
const re = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = re.exec(css)) !== null) {
  const sel = m[1].trim();
  if (sel.startsWith('@')) continue;
  const hits = m[2]
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => {
      const idx = d.indexOf(':');
      return idx > 0 && COLOR_PROPS.test(d.slice(0, idx).trim()) && LIT.test(d);
    });
  if (hits.length) lines.push(sel + '  {  ' + hits.join('  ;  '));
}
console.log('rules-with-color-literals=' + lines.length);
for (const l of lines) console.log(l);
