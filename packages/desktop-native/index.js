// Loads the locally built native addon. N-API is ABI-stable, so the same
// `index.node` works under both system Node and Electron's Node runtime.
// (A production setup would use @napi-rs/cli to emit per-platform artifacts.)
module.exports = require("./index.node");
