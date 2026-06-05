const fs = require('node:fs/promises');
const nbt = require('prismarine-nbt');
const { extractFlatMap } = require('./nerv-nbt');

async function readNbtRoot(filePath) {
  const buffer = await fs.readFile(filePath);
  const parsed = await nbt.parse(buffer);
  return nbt.simplify(parsed.parsed || parsed);
}

async function loadFlatMap(filePath, options = {}) {
  if (!filePath) {
    throw new Error('No map file configured. Set BOT_MAP_FILE or pass --map path/to/map.nbt.');
  }
  const root = await readNbtRoot(filePath);
  return extractFlatMap(root, options);
}

module.exports = {
  loadFlatMap,
  readNbtRoot
};
