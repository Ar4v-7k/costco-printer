const assert = require('node:assert/strict');
const test = require('node:test');
const { extractFlatMap, normalizeBlockName } = require('../src/nerv-nbt');

test('normalizeBlockName removes minecraft namespace', () => {
  assert.equal(normalizeBlockName('minecraft:white_carpet'), 'white_carpet');
  assert.equal(normalizeBlockName('stone'), 'stone');
});

test('extractFlatMap mirrors the addon flat NBT offset logic', () => {
  const root = {
    palette: [{ Name: 'minecraft:red_carpet' }, { Name: 'minecraft:blue_carpet' }],
    blocks: [
      { state: 0, pos: [10, 3, 50] },
      { state: 1, pos: [11, 3, 49] },
      { state: 1, pos: [11, 2, 50] }
    ]
  };

  const map = extractFlatMap(root);

  assert.equal(map.sourceOffset.x, 10);
  assert.equal(map.sourceOffset.z, -77);
  assert.equal(map.maxHeight, 3);
  assert.equal(map.cells[0][127], 'red_carpet');
  assert.equal(map.cells[1][126], 'blue_carpet');
  assert.equal(map.cells[1][127], null);
  assert.deepEqual(
    map.requirements.map((entry) => [entry.name, entry.count]),
    [
      ['blue_carpet', 1],
      ['red_carpet', 1]
    ]
  );
});

test('extractFlatMap can ignore configured blocks', () => {
  const root = {
    palette: [{ Name: 'minecraft:red_carpet' }, { Name: 'minecraft:air' }],
    blocks: [
      { state: 0, pos: [0, 0, 127] },
      { state: 1, pos: [1, 0, 127] }
    ]
  };

  const map = extractFlatMap(root, { ignoredBlocks: ['air'] });
  assert.equal(map.cells[0][127], 'red_carpet');
  assert.equal(map.cells[1][127], null);
});
