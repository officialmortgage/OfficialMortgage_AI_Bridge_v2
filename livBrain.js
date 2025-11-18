// ============================================================
// Liv Brain Loader
// - Loads all .txt modules from ./liv-brain-v4
// - Concatenates them into a single system prompt
// ============================================================

const fs = require("fs");
const path = require("path");

function loadLivBrain() {
  const brainDir = path.join(__dirname, "liv-brain-v4");

  if (!fs.existsSync(brainDir)) {
    console.error("liv-brain-v4 directory not found:", brainDir);
    return "You are Liv, the Official Mortgage AI assistant. (Brain directory missing.)";
  }

  const files = fs
    .readdirSync(brainDir)
    .filter((f) => f.toLowerCase().endsWith(".txt"))
    .sort(); // ensure consistent order

  if (files.length === 0) {
    console.error("No .txt files found in liv-brain-v4:", brainDir);
    return "You are Liv, the Official Mortgage AI assistant. (No brain modules found.)";
  }

  console.log("Loading Liv brain modules:", files);

  const parts = files.map((file) => {
    const fullPath = path.join(brainDir, file);
    return fs.readFileSync(fullPath, "utf8");
  });

  return parts.join("\n\n");
}

const livSystemPrompt = loadLivBrain();

module.exports = { livSystemPrompt };
