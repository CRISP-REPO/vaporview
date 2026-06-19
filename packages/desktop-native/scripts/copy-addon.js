// Copy the freshly built cdylib to `index.node` so Node/Electron can require it.
// Picks the platform-correct artifact name produced by `cargo build --release`.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const releaseDir = path.join(root, "target", "release");

const candidates = [
  "libvaporview_desktop_native.dylib", // macOS
  "libvaporview_desktop_native.so", // Linux
  "vaporview_desktop_native.dll", // Windows
];

const src = candidates.map((n) => path.join(releaseDir, n)).find(fs.existsSync);
if (!src) {
  console.error("No built addon found in", releaseDir, "- run `cargo build --release` first");
  process.exit(1);
}

const dest = path.join(root, "index.node");
fs.copyFileSync(src, dest);
console.log("copied", path.basename(src), "->", path.relative(root, dest));
