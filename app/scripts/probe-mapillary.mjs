// Quick probe: hit Mapillary v4 with the same fetch the engine uses.
const token = process.env.MLY_TOKEN || '';
if (!token) { console.error('usage: MLY_TOKEN=<token> node probe-mapillary.mjs'); process.exit(2); }

const bboxes = [
  // Much smaller bboxes — Mapillary error 1 says reduce data.
  { name: 'SF-tiny',         val: '-122.42,37.77,-122.41,37.78' },
  { name: 'Cypress-tiny',    val: '-95.69,29.97,-95.68,29.98'  },
];

for (const b of bboxes) {
  const url = `https://graph.mapillary.com/images?access_token=${encodeURIComponent(token)}&fields=id,geometry,is_pano&bbox=${b.val}&limit=50`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 RWR-Probe/1.0',
        'Accept': 'application/json',
      },
    });
    const text = await r.text();
    console.log(`${b.name}: status=${r.status} body=${text.slice(0, 300)}`);
  } catch (e) {
    console.log(`${b.name}: ERR ${e?.message ?? e}`);
  }
}
