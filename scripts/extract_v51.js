const fs = require('fs');
const transcriptPath = process.argv[2] || process.env.HORUS_TRANSCRIPT_JSONL;
if (!transcriptPath) {
  throw new Error('Usage: node scripts/extract_v51.js <transcript.jsonl> or set HORUS_TRANSCRIPT_JSONL');
}
const data = fs.readFileSync(transcriptPath, 'utf8');
const lines = data.split('\n');
for (const line of lines) {
  if (line.includes('"step_index":16181')) {
    try {
      const obj = JSON.parse(line);
      const rawCode = obj.tool_calls[0].args.CodeContent;
      // The CodeContent might be a JSON-escaped string (wrapped in quotes)
      let code;
      if (rawCode.startsWith('"') && rawCode.endsWith('"')) {
        code = JSON.parse(rawCode);
      } else {
        code = rawCode;
      }
      fs.writeFileSync('scripts/upgrade_v5_1.js', code);
      console.log('Written upgrade_v5_1.js, length:', code.length);
    } catch(e) {
      console.error('Parse error:', e.message);
    }
    break;
  }
}
