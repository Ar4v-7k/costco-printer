function normalizeBlockName(name) {
  if (!name || typeof name !== 'string') return null;
  return name.includes(':') ? name.split(':').at(-1) : name;
}

function getPaletteName(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return entry.Name || entry.name || null;
}

function getBlockStateId(block) {
  if (!block || typeof block !== 'object') return null;
  const value = block.state ?? block.State;
  return Number.isInteger(value) ? value : null;
}

function getBlockPos(block) {
  const pos = block?.pos || block?.Pos;
  if (!Array.isArray(pos) || pos.length < 3) return null;
  const [x, y, z] = pos.map(Number);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

function readPalette(root) {
  const palette = root?.palette || root?.Palette;
  if (!Array.isArray(palette)) {
    throw new Error('NBT file does not contain a palette list.');
  }

  return palette.map((entry, index) => {
    const fullName = getPaletteName(entry);
    const name = normalizeBlockName(fullName);
    if (!name) {
      throw new Error(`Palette entry ${index} is missing a block Name.`);
    }
    return { index, fullName, name };
  });
}

function readBlocks(root) {
  const blocks = root?.blocks || root?.Blocks;
  if (!Array.isArray(blocks)) {
    throw new Error('NBT file does not contain a blocks list.');
  }
  return blocks;
}

function extractFlatMap(root, { ignoredBlocks = [] } = {}) {
  const palette = readPalette(root);
  const blocks = readBlocks(root);
  const ignored = new Set(ignoredBlocks.map(normalizeBlockName).filter(Boolean));
  const activePalette = new Map();

  for (const entry of palette) {
    if (!ignored.has(entry.name)) {
      activePalette.set(entry.index, { ...entry, count: 0 });
    }
  }

  let maxHeight = Number.NEGATIVE_INFINITY;
  let minX = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const block of blocks) {
    const stateId = getBlockStateId(block);
    const pos = getBlockPos(block);
    if (stateId === null || !pos || !activePalette.has(stateId)) continue;
    maxHeight = Math.max(maxHeight, pos.y);
    minX = Math.min(minX, pos.x);
    maxZ = Math.max(maxZ, pos.z);
  }

  if (!Number.isFinite(maxHeight) || !Number.isFinite(minX) || !Number.isFinite(maxZ)) {
    throw new Error('NBT file has no placeable blocks after applying ignored blocks.');
  }

  const zOffset = maxZ - 127;
  const cells = Array.from({ length: 128 }, () => Array.from({ length: 128 }, () => null));

  for (const block of blocks) {
    const stateId = getBlockStateId(block);
    const pos = getBlockPos(block);
    if (stateId === null || !pos || !activePalette.has(stateId)) continue;

    const x = pos.x - minX;
    const z = pos.z - zOffset;
    if (pos.y !== maxHeight || x < 0 || x >= 128 || z < 0 || z >= 128) continue;

    const paletteEntry = activePalette.get(stateId);
    cells[x][z] = paletteEntry.name;
    paletteEntry.count += 1;
  }

  const requirements = [...activePalette.values()]
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    width: 128,
    depth: 128,
    maxHeight,
    sourceOffset: { x: minX, z: zOffset },
    cells,
    requirements
  };
}

module.exports = {
  extractFlatMap,
  normalizeBlockName
};
