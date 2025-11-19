// livBrain.js
// Load Liv brain from separate module files in /liv-brain-v4

const fs = require("fs");
const path = require("path");

function loadLivBrain() {
  const brainDir = path.join(__dirname, "liv-brain-v4");

  if (!fs.existsSync(brainDir)) {
    throw new Error(`Brain directory not found: ${brainDir}`);
  }

  // Only load the numbered module files 01_ ... 16_
  const files = fs
    .readdirSync(brainDir)
    .filter((name) => /^(0[1-9]|1[0-6])_.*\.txt$/.test(name))
    .sort(); // ensures 01_, 02_, ... 16_ order

  if (files.length === 0) {
    throw new Error(`No module files found in ${brainDir}`);
  }

  const parts = [];

  for (const file of files) {
    const fullPath = path.join(brainDir, file);
    const content = fs.readFileSync(fullPath, "utf8").trim();
    if (!content) continue;

    parts.push(
      [
        `\n\n[START MODULE ${file}]`,
        content,
        `[END MODULE ${file}]\n`
      ].join("\n")
    );
  }

  return parts.join("\n");
}

const livSystemPrompt = loadLivBrain();

module.exports = { livSystemPrompt };
