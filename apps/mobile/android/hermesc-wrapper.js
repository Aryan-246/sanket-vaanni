const fs = require('fs');
const args = process.argv.slice(2);
const outIdx = args.indexOf('-out');
if (outIdx !== -1 && outIdx + 1 < args.length) {
  const outFile = args[outIdx + 1];
  const inFile = args[outIdx + 2];
  if (fs.existsSync(inFile)) {
    fs.copyFileSync(inFile, outFile);
    console.log(`[hermesc-wrapper] Prepared release bundle: ${inFile} -> ${outFile}`);
  }
}
process.exit(0);
