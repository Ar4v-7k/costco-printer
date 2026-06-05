function makePlacementPlan(map, origin) {
  const placements = [];

  for (let x = 0; x < map.width; x += 1) {
    const northToSouth = x % 2 === 0;
    for (let step = 0; step < map.depth; step += 1) {
      const z = northToSouth ? step : map.depth - 1 - step;
      const blockName = map.cells[x][z];
      if (!blockName) continue;

      placements.push({
        index: placements.length,
        x,
        z,
        blockName,
        position: {
          x: origin.x + x,
          y: origin.y,
          z: origin.z + z
        }
      });
    }
  }

  return placements;
}

function summarizePlan(placements) {
  const counts = new Map();
  for (const placement of placements) {
    counts.set(placement.blockName, (counts.get(placement.blockName) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([blockName, count]) => ({ blockName, count }))
    .sort((a, b) => b.count - a.count || a.blockName.localeCompare(b.blockName));
}

module.exports = {
  makePlacementPlan,
  summarizePlan
};
