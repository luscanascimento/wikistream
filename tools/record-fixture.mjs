// Records events off the live Wikimedia firehose into the NDJSON fixture the
// tests replay. Run it only to refresh that file — nothing in the build, the
// test run or CI touches the network.
//
//   node tools/record-fixture.mjs src/app/fixtures/recentchange.ndjson 300
//
// Payloads are written exactly as they arrive, one JSON object per line.
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'src/app/fixtures/recentchange.ndjson';
const want = Number(process.argv[3] ?? 300);

const response = await fetch('https://stream.wikimedia.org/v2/stream/recentchange', {
  headers: { accept: 'text/event-stream' },
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);

const lines = [];
const decoder = new TextDecoder();
let buffer = '';

for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trimEnd();
    buffer = buffer.slice(newline + 1);
    if (!line.startsWith('data: ')) continue;

    const payload = line.slice(6);
    try {
      JSON.parse(payload);
    } catch {
      continue; // A frame that does not parse is not worth recording.
    }
    lines.push(payload);
    if (lines.length >= want) {
      writeFileSync(out, lines.join('\n') + '\n');
      console.log(`wrote ${lines.length} events to ${out}`);
      process.exit(0);
    }
  }
}
