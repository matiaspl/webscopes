const path = require("node:path");

const abi = process.env.WEBSCOPES_FRAME_RING_ABI || (process.versions.electron ? "electron" : "node");
const addonPath = path.join(__dirname, "native", "frame-ring", abi, "frame_ring.node");

module.exports = require(addonPath);
