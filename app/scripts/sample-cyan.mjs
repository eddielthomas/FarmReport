// Sample the QA screenshot for cyan-ish pixels (the Mapillary dot color).
// rgb(34, 211, 238). Counts pixels matching within tolerance.

import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const buf = readFileSync('D:/Projects/RWR/mvp/.qa-dots.png');
const png = PNG.sync.read(buf);
const { width, height, data } = png;
let cyanCount = 0;
let strongCyanCount = 0;
const samples = [];
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const r = data[i], g = data[i+1], b = data[i+2];
    // cyan: low R, high G, high B, G & B close, R << G
    if (r < 100 && g > 150 && b > 180 && Math.abs(g - b) < 60) {
      cyanCount++;
      if (r < 60 && g > 190 && b > 210) {
        strongCyanCount++;
        if (samples.length < 10) samples.push(`(${x},${y}) rgb(${r},${g},${b})`);
      }
    }
  }
}
console.log(`image: ${width}x${height}`);
console.log(`cyanish pixels: ${cyanCount}`);
console.log(`strong cyan pixels: ${strongCyanCount}`);
console.log(`samples:`, samples.join(' '));
