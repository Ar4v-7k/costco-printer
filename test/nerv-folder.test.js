const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applyNervConfig, carpetConfigFromJson, findNextMapFile, materialChestsFromConfig, sortLikeAddon } = require('../src/nerv-folder');

test('sortLikeAddon sorts by filename length then alphabetically', () => {
  const files = ['yamato_10_0.nbt', 'b.nbt', 'aa.nbt', 'a.nbt'].map((name) => ({ name }));
  assert.deepEqual(
    sortLikeAddon(files).map((file) => file.name),
    ['a.nbt', 'b.nbt', 'aa.nbt', 'yamato_10_0.nbt']
  );
});

test('findNextMapFile reads only top-level nbt files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nerv-folder-'));
  await fs.mkdir(path.join(dir, '_finished_maps'));
  await fs.writeFile(path.join(dir, 'bbb.nbt'), '');
  await fs.writeFile(path.join(dir, 'a.nbt'), '');
  await fs.writeFile(path.join(dir, '_finished_maps', '0.nbt'), '');

  assert.equal(await findNextMapFile(dir), path.join(dir, 'a.nbt'));
});

test('findNextMapFile skips started files unless maps are moved away', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nerv-folder-'));
  await fs.writeFile(path.join(dir, 'a.nbt'), '');
  await fs.writeFile(path.join(dir, 'b.nbt'), '');

  assert.equal(await findNextMapFile(dir, [path.join(dir, 'a.nbt')], false), path.join(dir, 'b.nbt'));
  assert.equal(await findNextMapFile(dir, [path.join(dir, 'a.nbt')], true), path.join(dir, 'a.nbt'));
});

test('applyNervConfig fills mode and origin when not explicitly provided', () => {
  const runtime = {
    nerv: {},
    printer: {
      mode: 'flat',
      modeProvided: false,
      originProvided: false,
      origin: { x: 0, y: 64, z: 0 }
    }
  };

  applyNervConfig(runtime, {
    path: '/tmp/config.json',
    config: {
      type: 'carpet',
      mapCorner: { x: -1, y: 108, z: -2 },
      materialDict: { 'minecraft:red_carpet': [] }
    }
  });

  assert.equal(runtime.printer.mode, 'carpet');
  assert.deepEqual(runtime.printer.origin, { x: -1, y: 108, z: -2 });
  assert.equal(runtime.nerv.materialCount, 1);
});

test('materialChestsFromConfig normalizes block names', () => {
  const chests = materialChestsFromConfig({
    materialDict: {
      'minecraft:red_carpet': [
        {
          blockPos: { x: '1', y: '2', z: '3' },
          openPos: { x: '1.5', y: '2.5', z: '3.5' }
        }
      ]
    }
  });

  assert.deepEqual(chests.red_carpet, [
    {
      blockPos: { x: 1, y: 2, z: 3 },
      openPos: { x: 1.5, y: 2.5, z: 3.5 }
    }
  ]);
});

test('carpetConfigFromJson loads required carpet automation endpoints', () => {
  const interaction = {
    blockPos: { x: 1, y: 2, z: 3 },
    openPos: { x: 1.5, y: 2.5, z: 3.5 }
  };
  const config = carpetConfigFromJson({
    type: 'carpet',
    reset: interaction,
    cartographyTable: interaction,
    finishedMapChest: interaction,
    mapMaterialChests: [interaction],
    dumpStation: { pos: { x: 4, y: 5, z: 6 }, yaw: '90', pitch: '30' },
    mapCorner: { x: 7, y: 8, z: 9 },
    materialDict: { 'minecraft:red_carpet': [interaction] }
  });

  assert.equal(config.type, 'carpet');
  assert.deepEqual(config.mapCorner, { x: 7, y: 8, z: 9 });
  assert.equal(config.mapMaterialChests.length, 1);
  assert.deepEqual(config.dumpStation, { pos: { x: 4, y: 5, z: 6 }, yaw: 90, pitch: 30 });
  assert.equal(config.materialChests.red_carpet.length, 1);
});
