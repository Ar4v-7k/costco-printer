const assert = require('node:assert/strict');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { NervCarpetPrinter, stacksRequired } = require('../src/nerv-carpet-printer');

function emptyCells() {
  return Array.from({ length: 128 }, () => Array.from({ length: 128 }, () => null));
}

function fakeBot() {
  const slots = Array.from({ length: 46 }, () => null);
  return {
    QUICK_BAR_START: 36,
    quickBarSlot: 0,
    entity: { position: new Vec3(0, 108, 0), pitch: 0 },
    inventory: {
      items: () => [],
      emptySlotCount: () => 10,
      slots
    },
    registry: {
      itemsByName: {}
    },
    setQuickBarSlot(slot) {
      this.quickBarSlot = slot;
    },
    blockAt: () => ({ name: 'air' }),
    setControlState: () => {},
    look: async () => {},
    pathfinder: {
      setGoal: () => {}
    }
  };
}

function fakeConfig() {
  const interaction = {
    blockPos: { x: 1, y: 108, z: 1 },
    openPos: { x: 1.5, y: 108, z: 1.5 }
  };
  return {
    nerv: {
      folder: '/tmp',
      carpetConfig: {
        type: 'carpet',
        reset: interaction,
        cartographyTable: interaction,
        finishedMapChest: interaction,
        mapMaterialChests: [interaction],
        dumpStation: { pos: { x: 0, y: 108, z: -2 }, yaw: 0, pitch: 0 },
        mapCorner: { x: 0, y: 108, z: 0 },
        materialChests: {
          red_carpet: [interaction],
          blue_carpet: [interaction]
        }
      }
    },
    printer: {
      linesPerRun: 3,
      northToSouth: true,
      placeDelayMs: 50,
      placeRange: 4,
      minPlaceDistance: 0.8,
      mapFillSquareSize: 1,
      sprintMode: 'NotPlacing',
      checkpointBuffer: 1.5,
      interactCheckpointBuffer: 0.85,
      backfillEdgeBuffer: 1,
      holdOpenEdge: true,
      packetSneakPlace: true,
      errorAction: 'Repair',
      disableOnFinished: true,
      moveToFinishedFolder: false
    }
  };
}

function item(name, count, slot) {
  return { name, count, slot, type: slot };
}

test('stacksRequired mirrors addon stack math', () => {
  assert.equal(stacksRequired([0, 1, 64, 65, 128]), 6);
});

test('calculateBuildingPath creates addon-style alternating line checkpoints', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  cells[3][127] = 'blue_carpet';
  const printer = new NervCarpetPrinter(fakeBot(), fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  printer.calculateBuildingPath(true, true);

  assert.deepEqual(
    printer.checkpoints.map((checkpoint) => [checkpoint.action, checkpoint.goal.x, checkpoint.goal.z]),
    [
      ['sprint', 0.5, 0.5],
      ['lineEnd', 0.5, 127.5],
      ['', 3.5, 127.5],
      ['lineEnd', 3.5, 0.5]
    ]
  );
});

test('getRequiredItems uses reachable inventory capacity window', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  cells[0][1] = 'red_carpet';
  cells[0][2] = 'blue_carpet';
  const printer = new NervCarpetPrinter(fakeBot(), fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlotCount = 2;

  assert.deepEqual([...printer.getRequiredItems().entries()], [
    ['red_carpet', 2],
    ['blue_carpet', 1]
  ]);
});

test('tryPlacingBlock confirms placement immediately when server update arrives', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  let sends = 0;
  let placed = false;
  const bot = fakeBot();
  bot.heldItem = { name: 'red_carpet' };
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.inventory.items = () => [{ name: 'red_carpet', count: 64 }];
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 107 && pos.z === 0) return { name: 'stone' };
    if (pos.x === 0 && pos.y === 108 && pos.z === 0 && placed) return { name: 'red_carpet' };
    return { name: 'air' };
  };
  bot.lookAt = async () => {};
  bot._genericPlace = async () => {
    sends += 1;
    placed = true;
  };
  const config = fakeConfig();
  config.printer.placementRetries = 2;
  config.printer.placementVerifyMs = 0;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];

  const placedNow = await printer.tryPlacingBlock({ x: 0, y: 108, z: 0 });
  assert.equal(placedNow, true);
  assert.equal(sends, 1);
  assert.equal(printer.sentPlacements, 1);
  assert.deepEqual(printer.knownErrors, []);
  assert.equal(printer.optimisticPlacements.has('0,108,0'), true);
});

test('hotbarSlotWith trusts held item after Mineflayer equip fallback', () => {
  const bot = fakeBot();
  bot.quickBarSlot = 2;
  bot.heldItem = { name: 'cyan_carpet' };
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableHotBarSlots = [0, 1, 2];

  assert.equal(printer.hotbarSlotWith('cyan_carpet'), 2);
});

test('tryPlacingBlock queues unconfirmed holes for fast retry without blocking', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  let sends = 0;
  const bot = fakeBot();
  bot.heldItem = { name: 'red_carpet' };
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.inventory.items = () => [{ name: 'red_carpet', count: 64 }];
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 107 && pos.z === 0) return { name: 'stone' };
    return { name: 'air' };
  };
  bot.lookAt = async () => {};
  bot._genericPlace = async () => { sends += 1; };
  const config = fakeConfig();
  config.printer.placementRetries = 12;
  config.printer.placementVerifyMs = 0;
  config.printer.placementRetryDelayMs = 1;
  config.printer.placementPendingMs = 10;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];

  const placedNow = await printer.tryPlacingBlock({ x: 0, y: 108, z: 0 });
  assert.equal(placedNow, true);
  assert.equal(sends, 1);
  assert.equal(printer.pendingPlacements.get('0,108,0').attempts, 1);
  assert.equal(printer.optimisticPlacements.has('0,108,0'), true);
});

test('findClosestPlacement prioritizes due pending holes before new cells', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  cells[0][1] = 'blue_carpet';
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 2.5);
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone' };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  config.printer.placementRetries = 12;
  config.printer.placementRetries = 12;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.pendingPlacements.set('0,108,0', {
    pos: { x: 0, y: 108, z: 0 },
    material: 'red_carpet',
    attempts: 1,
    nextRetryAt: Date.now() - 1
  });
  printer.optimisticPlacements.set('0,108,0', {
    material: 'red_carpet',
    expiresAt: Date.now() + 10000
  });

  const placement = printer.findClosestPlacement({ x: 0.5, y: 108, z: 127.5 }, new Set());

  assert.deepEqual(placement, { x: 0, y: 108, z: 0 });
});

test('confirmed pending placement is cleared from retry queue', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: 'red_carpet' };
    return { name: 'air' };
  };
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.pendingPlacements.set('0,108,0', {
    pos: { x: 0, y: 108, z: 0 },
    material: 'red_carpet',
    attempts: 1,
    nextRetryAt: Date.now() - 1
  });
  printer.optimisticPlacements.set('0,108,0', {
    material: 'red_carpet',
    expiresAt: Date.now() + 10000
  });

  printer.pruneOptimisticPlacements();

  assert.equal(printer.pendingPlacements.has('0,108,0'), false);
  assert.equal(printer.optimisticPlacements.has('0,108,0'), false);
});

test('wrong solid placements leave retry queue for line-end repair', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: 'blue_carpet' };
    return { name: 'air' };
  };
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.pendingPlacements.set('0,108,0', {
    pos: { x: 0, y: 108, z: 0 },
    material: 'red_carpet',
    attempts: 1,
    nextRetryAt: Date.now() - 1
  });
  printer.optimisticPlacements.set('0,108,0', {
    material: 'red_carpet',
    expiresAt: Date.now() + 10000
  });

  printer.pruneOptimisticPlacements();

  assert.equal(printer.pendingPlacements.has('0,108,0'), false);
  assert.equal(printer.optimisticPlacements.has('0,108,0'), false);
});

test('solid pending entries are pruned after optimistic expiry', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: 'red_carpet' };
    return { name: 'air' };
  };
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.pendingPlacements.set('0,108,0', {
    pos: { x: 0, y: 108, z: 0 },
    material: 'red_carpet',
    attempts: 1,
    nextRetryAt: Date.now() - 1
  });

  printer.pruneOptimisticPlacements();

  assert.equal(printer.pendingPlacements.has('0,108,0'), false);
});

test('tickWalking pauses sealed movement while a pending hole waits to retry', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  cells[0][1] = 'blue_carpet';
  const controls = [];
  let sends = 0;
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 2.5);
  bot.setControlState = (control, state) => controls.push([control, state]);
  bot.heldItem = { name: 'red_carpet' };
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.inventory.slots[37] = item('blue_carpet', 64, 37);
  bot.inventory.items = () => [{ name: 'red_carpet', count: 64 }, { name: 'blue_carpet', count: 64 }];
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone' };
    return { name: 'air' };
  };
  bot._genericPlace = async () => { sends += 1; };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  config.printer.placementRetries = 12;
  config.printer.pendingHoldEdgeBuffer = 3;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1];
  printer.availableHotBarSlots = [0, 1];
  printer.checkpoints = [{ goal: { x: 0.5, y: 108, z: 127.5 }, action: 'lineEnd' }];
  printer.pendingPlacements.set('0,108,0', {
    pos: { x: 0, y: 108, z: 0 },
    material: 'red_carpet',
    attempts: 1,
    nextRetryAt: Date.now() + 10000
  });

  await printer.tickWalking(10);

  assert.deepEqual(controls, [['forward', false], ['sprint', false]]);
  assert.equal(sends, 2);
  assert.equal(printer.pendingPlacements.get('0,108,0').attempts, 2);
});

test('allowedPlacements caps long catch-up bursts', (t) => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const config = fakeConfig();
  config.printer.placeDelayMs = 20;
  config.printer.maxPlacementsPerTick = 4;
  const printer = new NervCarpetPrinter(fakeBot(), config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.lastPlacementTime = 0;

  assert.equal(printer.allowedPlacements(), 4);
  assert.equal(printer.lastPlacementTime, now);
  assert.equal(printer.allowedPlacements(), 0);
  now += 50;
  assert.equal(printer.allowedPlacements(), 2);
});

test('tickWalking retries a due pending hole before advancing', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  cells[0][1] = 'blue_carpet';
  const controls = [];
  let sends = 0;
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 2.5);
  bot.setControlState = (control, state) => controls.push([control, state]);
  bot.heldItem = { name: 'red_carpet' };
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.inventory.slots[37] = item('blue_carpet', 64, 37);
  bot.inventory.items = () => [{ name: 'red_carpet', count: 64 }, { name: 'blue_carpet', count: 64 }];
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air' };
  };
  bot._genericPlace = async () => { sends += 1; };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  config.printer.placementRetries = 12;
  config.printer.placementBurst = 1;
  config.printer.pendingHoldEdgeBuffer = 3;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1];
  printer.availableHotBarSlots = [0, 1];
  printer.checkpoints = [{ goal: { x: 0.5, y: 108, z: 127.5 }, action: 'lineEnd' }];
  printer.pendingPlacements.set('0,108,0', {
    pos: { x: 0, y: 108, z: 0 },
    material: 'red_carpet',
    attempts: 1,
    nextRetryAt: Date.now() - 1
  });

  await printer.tickWalking(10);

  assert.deepEqual(controls, [['forward', false], ['sprint', false]]);
  assert.equal(sends, 2);
  assert.equal(printer.pendingPlacements.get('0,108,0').attempts, 2);
});

test('stubborn open pending holes are kept instead of abandoned', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 2.5);
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone' };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  config.printer.placementRetries = 2;
  config.printer.placementAbandonMs = 30000;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.pendingPlacements.set('0,108,0', {
    pos: { x: 0, y: 108, z: 0 },
    material: 'red_carpet',
    attempts: 2,
    nextRetryAt: Date.now() - 1
  });

  const placement = printer.findClosestPlacement({ x: 0.5, y: 108, z: 127.5 }, new Set());
  assert.deepEqual(placement, { x: 0, y: 108, z: 0 });
  assert.equal(printer.pendingPlacements.has('0,108,0'), true);
  assert.equal(printer.abandonedPlacements.has('0,108,0'), false);
});

test('stubborn open pending holes switch to careful look placement', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 2.5);
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.inventory.items = () => [{ name: 'red_carpet', count: 64 }];
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air' };
  };
  let looked = false;
  bot.lookAt = async () => { looked = true; };
  bot._genericPlace = async () => {};
  const config = fakeConfig();
  config.printer.placementCarefulAfterAttempts = 8;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.pendingPlacements.set('0,108,0', {
    pos: { x: 0, y: 108, z: 0 },
    material: 'red_carpet',
    attempts: 8,
    nextRetryAt: Date.now() - 1
  });

  await printer.tryPlacingBlock({ x: 0, y: 108, z: 0 });
  assert.equal(looked, true);
});

test('stubborn solid pending placements are dropped for later repair', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 2.5);
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone' };
    return { name: 'blue_carpet' };
  };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  config.printer.placementRetries = 2;
  config.printer.placementAbandonMs = 30000;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.pendingPlacements.set('0,108,0', {
    pos: { x: 0, y: 108, z: 0 },
    material: 'red_carpet',
    attempts: 2,
    nextRetryAt: Date.now() - 1
  });

  assert.equal(printer.findClosestPlacement({ x: 0.5, y: 108, z: 127.5 }, new Set()), null);
  assert.equal(printer.pendingPlacements.has('0,108,0'), false);
  assert.equal(printer.abandonedPlacements.has('0,108,0'), false);
});

test('tickWalking pauses sealed movement once a pending hole falls behind lookbehind', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  cells[0][1] = 'blue_carpet';
  const controls = [];
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 2.5);
  bot.setControlState = (control, state) => controls.push([control, state]);
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  config.printer.placementRetries = 12;
  config.printer.pendingHoldEdgeBuffer = 0.75;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1];
  printer.availableHotBarSlots = [0, 1];
  printer.checkpoints = [{ goal: { x: 0.5, y: 108, z: 127.5 }, action: 'lineEnd' }];
  printer.pendingPlacements.set('0,108,0', {
    pos: { x: 0, y: 108, z: 0 },
    material: 'red_carpet',
    attempts: 1,
    nextRetryAt: Date.now() + 10000
  });

  await printer.tickWalking(0);

  assert.deepEqual(controls, [['forward', false], ['sprint', false]]);
});

test('tickWalking never pathfinds during print rows, even after a stall', async () => {
  const cells = emptyCells();
  const goalsSet = [];
  const controls = [];
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 0.5);
  bot.setControlState = (control, state) => controls.push([control, state]);
  bot.pathfinder = {
    movements: {},
    setGoal(goal) {
      goalsSet.push(goal);
    }
  };
  const config = fakeConfig();
  config.printer.pathfinderForInteractTravel = true;
  config.printer.walkingStallMs = 1;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.checkpoints = [{ goal: { x: 0.5, y: 108, z: 10.5 }, action: 'lineEnd' }];

  await printer.tickWalking(0);
  await printer.tickWalking(0);

  assert.equal(goalsSet.length, 0);
  assert.equal(controls.some(([control, state]) => control === 'forward' && state === true), true);
});

test('findClosestPlacement keeps original addon closest-cell ordering', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  cells[0][4] = 'blue_carpet';
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 4.5);
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  config.printer.backfillEdgeBuffer = 1;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  const placement = printer.findClosestPlacement({ x: 0.5, y: 108, z: 127.5 }, new Set());

  assert.deepEqual(placement, { x: 0, y: 108, z: 4 });
});

test('findSealedPlacement picks urgent behind hole before closer future cell', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  cells[0][4] = 'blue_carpet';
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 4.5);
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  config.printer.sealLookbehindBlocks = 0.75;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  const placement = printer.findSealedPlacement({ x: 0.5, y: 108, z: 127.5 }, new Set());

  assert.deepEqual(placement, { x: 0, y: 108, z: 0 });
});

test('findSealedPlacement ignores optimistic state for urgent real air', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  cells[0][4] = 'blue_carpet';
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 4.5);
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.optimisticPlacements.set('0,108,0', {
    material: 'red_carpet',
    expiresAt: Date.now() + 10000
  });

  assert.deepEqual(
    printer.findSealedPlacement({ x: 0.5, y: 108, z: 127.5 }, new Set()),
    { x: 0, y: 108, z: 0 }
  );
});

test('findSealHoldCandidate ignores future cells that are out of range', () => {
  const cells = emptyCells();
  cells[0][8] = 'red_carpet';
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 0.5);
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.sealMaxBacktrackBlocks = 3;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  assert.equal(printer.findSealHoldCandidate({ x: 0.5, y: 108, z: 127.5 }), null);
});

test('tickWalking keeps pace for edge-only seal candidates that are not behind', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const controls = [];
  let sends = 0;
  const bot = fakeBot();
  bot.entity.position = new Vec3(-4.3, 108, 0.5);
  bot.setControlState = (control, state) => controls.push([control, state]);
  bot.heldItem = { name: 'red_carpet' };
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.inventory.items = () => [{ name: 'red_carpet', count: 64 }];
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air' };
  };
  bot._genericPlace = async () => { sends += 1; };
  const config = fakeConfig();
  config.printer.linesPerRun = 5;
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  config.printer.sealEdgeMargin = 0.35;
  config.printer.sealLookbehindBlocks = 0.75;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.checkpoints = [{ goal: { x: 0.5, y: 108, z: 127.5 }, action: 'lineEnd' }];

  await printer.tickWalking(0);

  assert.deepEqual(controls, [['forward', true], ['sprint', false]]);
  assert.equal(sends, 1);
});

test('tickWalking keeps pace for tiny seal misses but still prioritizes them', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const controls = [];
  let sends = 0;
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 1.4);
  bot.setControlState = (control, state) => controls.push([control, state]);
  bot.heldItem = { name: 'red_carpet' };
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.inventory.items = () => [{ name: 'red_carpet', count: 64 }];
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air' };
  };
  bot._genericPlace = async () => { sends += 1; };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  config.printer.sealLookbehindBlocks = 0.75;
  config.printer.sealMovementHoldBehind = 0.6;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.checkpoints = [{ goal: { x: 0.5, y: 108, z: 127.5 }, action: 'lineEnd' }];

  await printer.tickWalking(0);

  assert.deepEqual(controls, [['forward', true], ['sprint', false]]);
  assert.equal(sends, 1);
});

test('steerForSealHold steps away from too-close line-end cells', () => {
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 0.7);
  const config = fakeConfig();
  config.printer.minPlaceDistance = 0.8;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  let target = null;
  printer.steerToward = (goal) => {
    target = goal;
  };

  printer.steerForSealHold({
    pos: { x: 0, y: 108, z: 0 },
    metrics: { distance: 0.2 }
  }, {
    goal: { x: 0.5, y: 108, z: 0.5 },
    action: 'lineEnd'
  });

  assert.ok(target);
  assert.equal(target.z > 1.0, true);
});

test('tickWalking blocks line-end checkpoint until the strip is sealed', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const controls = [];
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 127.5);
  bot.setControlState = (control, state) => controls.push([control, state]);
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.checkpointBuffer = 0.2;
  config.printer.minCheckpointBuffer = 0.2;
  config.printer.placeRange = 5;
  config.printer.sealMaxBacktrackBlocks = 3;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.checkpoints = [{ goal: { x: 0.5, y: 108, z: 127.5 }, action: 'lineEnd' }];

  await printer.tickWalking(4);

  assert.equal(printer.checkpoints.length, 1);
  assert.equal(printer.checkpoints[0].action, 'lineEnd');
  assert.equal(controls.some(([control, state]) => control === 'forward' && state === true), true);
});

test('simulated sealed print retries a dropped packet before walking past it', async () => {
  const cells = emptyCells();
  for (let z = 0; z < 4; z += 1) cells[0][z] = 'red_carpet';
  const controls = [];
  const placed = new Set(['0,108,1', '0,108,2', '0,108,3']);
  const attempts = new Map();
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 2.6);
  bot.setControlState = (control, state) => controls.push([control, state]);
  bot.heldItem = { name: 'red_carpet' };
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.inventory.items = () => [{ name: 'red_carpet', count: 64 }];
  bot.blockAt = (pos) => {
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    if (placed.has(key)) return { name: 'red_carpet', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air', position: new Vec3(pos.x, pos.y, pos.z) };
  };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  config.printer.placementBurst = 1;
  config.printer.sealUrgentBurst = 4;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.checkpoints = [{ goal: { x: 0.5, y: 108, z: 127.5 }, action: 'lineEnd' }];
  printer.placeOnReference = async (reference, pos) => {
    const key = `${pos.x},${pos.y},${pos.z}`;
    const count = (attempts.get(key) || 0) + 1;
    attempts.set(key, count);
    if (key !== '0,108,0' || count > 1) placed.add(key);
    return 1;
  };

  await printer.tickWalking(1);
  await printer.tickWalking(1);

  assert.equal(attempts.get('0,108,0'), 2);
  assert.equal(placed.has('0,108,0'), true);
  assert.equal(controls.some(([control, state]) => control === 'forward' && state === false), true);
});

test('water in the map layer is treated as replaceable for carpet placement', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 2.5);
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: 'water' };
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  assert.equal(printer.isMapAreaClear(), true);
  assert.deepEqual(
    printer.findClosestPlacement({ x: 0.5, y: 108, z: 127.5 }, new Set()),
    { x: 0, y: 108, z: 0 }
  );
});

test('stuck reset water is queued for bucket drain when a dispenser is underneath', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: 'water', position: new Vec3(0, 108, 0), properties: { level: 0 } };
    if (pos.x === 0 && pos.y === 107 && pos.z === 0) return { name: 'dispenser', position: new Vec3(0, 107, 0) };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.drainResetWater = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitAreaClear';

  await printer.tick();

  assert.equal(printer.state, 'Walking');
  assert.equal(printer.checkpoints[0].action, 'waterBucketPickup');
  assert.deepEqual(printer.checkpoints[0].target, { x: 0, y: 108, z: 0 });
  assert.deepEqual(printer.checkpoints[0].dispenser, { x: 0, y: 107, z: 0 });
});

test('visible water interrupts walking print path for drain', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: 'water', position: new Vec3(0, 108, 0), properties: { level: 0 } };
    if (pos.x === 0 && pos.y === 107 && pos.z === 0) return { name: 'dispenser', position: new Vec3(0, 107, 0) };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.drainResetWater = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'Walking';
  printer.checkpoints = [{ goal: { x: 10, y: 108, z: 10 }, action: 'lineEnd' }];

  await printer.tick();

  assert.equal(printer.state, 'Walking');
  assert.equal(printer.checkpoints[0].action, 'waterBucketPickup');
  assert.deepEqual(printer.checkpoints[0].target, { x: 0, y: 108, z: 0 });
});

test('visible water watcher does not overwrite queued drain job', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: 'water', position: new Vec3(0, 108, 0), properties: { level: 0 } };
    if (pos.x === 0 && pos.y === 107 && pos.z === 0) return { name: 'dispenser', position: new Vec3(0, 107, 0) };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.drainResetWater = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'Walking';
  printer.checkpoints = [{ goal: { x: 0.5, y: 108.5, z: 0.5 }, action: 'waterBucketPickup', target: { x: 0, y: 108, z: 0 } }];

  const queued = printer.queueVisibleWaterDrainIfNeeded();

  assert.equal(queued, false);
  assert.equal(printer.checkpoints.length, 1);
  assert.equal(printer.checkpoints[0].action, 'waterBucketPickup');
  assert.equal(printer.waterDrainAttempts.size, 0);
});

test('visible water watcher does not interrupt queued reset path', () => {
  const cells = emptyCells();
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: 'water', position: new Vec3(0, 108, 0), properties: { level: 0 } };
    if (pos.x === 0 && pos.y === 107 && pos.z === 0) return { name: 'dispenser', position: new Vec3(0, 107, 0) };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.drainResetWater = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'Walking';
  printer.checkpoints = [{ goal: { x: 1.5, y: 108, z: 1.5 }, action: 'reset', target: { x: 1, y: 108, z: 1 } }];

  const queued = printer.queueVisibleWaterDrainIfNeeded();

  assert.equal(queued, false);
  assert.equal(printer.checkpoints.length, 1);
  assert.equal(printer.checkpoints[0].action, 'reset');
});

test('water scan only drains source water on carpet y-level', () => {
  const cells = emptyCells();
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) {
      return { name: 'water', position: new Vec3(0, 108, 0), properties: { level: 0 } };
    }
    if (pos.x === 1 && pos.y === 108 && pos.z === 0) {
      return { name: 'water', position: new Vec3(1, 108, 0), properties: { level: 3 } };
    }
    if (pos.x === 2 && pos.y === 109 && pos.z === 0) {
      return { name: 'water', position: new Vec3(2, 109, 0), properties: { level: 0 } };
    }
    if (pos.x === 3 && pos.y === 108 && pos.z === 0) {
      return { name: 'water', position: new Vec3(3, 108, 0) };
    }
    if (pos.y === 107 && [0, 1, 2, 3].includes(pos.x)) return { name: 'dispenser', position: new Vec3(pos.x, 107, pos.z) };
    return { name: 'air' };
  };
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  const sources = printer.findDrainableWaterSources();

  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].pos, { x: 0, y: 108, z: 0 });
});

test('water dispenser open failure postpones that source', () => {
  const cells = emptyCells();
  const printer = new NervCarpetPrinter(fakeBot(), fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitWaterBucketPickup';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    access: 'top'
  };
  printer.lastInteractRecoveryCheckpoint = {
    goal: { x: 0.5, y: 108.5, z: 0.5 },
    action: 'waterBucketPickup',
    target: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    access: 'top'
  };
  printer.interactRecoveryCycleCount = 2;

  const handled = printer.handleInteractTimeoutFallback();

  assert.equal(handled, true);
  assert.equal(printer.state, 'AwaitAreaClear');
  assert.equal(printer.checkpoints.length, 0);
  assert.equal(printer.waterMissingBucketSources.has('0,108,0'), true);
});

test('water pickup timeout skips source after first failed cycle', async () => {
  const bot = fakeBot();
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitWaterBucketPickup';
  printer.settings.retryInteractMs = 50;
  printer.lastInteractedBlockPos = { x: 0, y: 107, z: 0 };
  printer.lastInteractRecoveryCheckpoint = {
    goal: { x: 0.5, y: 108.5, z: 0.5 },
    action: 'waterBucketPickup',
    target: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    access: 'top'
  };
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    access: 'top'
  };
  printer.interactTimeoutTicks = 1;

  await printer.tick();

  assert.equal(printer.state, 'AwaitAreaClear');
  assert.equal(printer.waterDrainCurrent, null);
  assert.equal(printer.waterMissingBucketSources.has('0,108,0'), true);
});

test('water bucket drain equips bucket and queues storing it back', async () => {
  const cells = emptyCells();
  let hasWater = true;
  let held = 'bucket';
  let activated = false;
  const bot = fakeBot();
  bot.inventory.items = () => held === 'bucket' ? [item('bucket', 1, 36)] : [item('water_bucket', 1, 36)];
  bot.equip = async (stack) => { held = stack.name; };
  bot.lookAt = async () => {};
  bot.activateBlock = async () => {
    activated = true;
    hasWater = false;
    held = 'water_bucket';
  };
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) {
      return { name: hasWater ? 'water' : 'air', position: new Vec3(0, 108, 0), properties: hasWater ? { level: 0 } : undefined };
    }
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.waterDrainActionDelayMs = 0;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'WaterBucketDrain';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 }
  };

  await printer.tickWaterBucketDrain();

  assert.equal(activated, true);
  assert.equal(printer.state, 'Walking');
  assert.equal(printer.checkpoints[0].action, 'waterBucketStore');
});

test('water pickup resumes draining when an empty bucket is already carried', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  bot.inventory.items = () => [item('bucket', 1, 36)];
  let interacted = false;
  bot.blockAt = () => ({ name: 'dispenser', position: new Vec3(0, 107, 0) });
  bot._client = { write() { interacted = true; } };
  bot.supportFeature = () => false;
  const config = fakeConfig();
  config.printer.waterDrainActionDelayMs = 0;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  const keepWalking = await printer.handleCheckpoint({
    action: 'waterBucketPickup',
    target: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    bucketReady: true
  });

  assert.equal(keepWalking, false);
  assert.equal(printer.state, 'WaterBucketDrain');
  assert.equal(interacted, false);
});

test('water dispenser pickup uses left-click-only open path', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  let activated = false;
  let packetSent = false;
  let leftClickSent = false;
  const controls = [];
  bot.blockAt = () => ({ name: 'dispenser', position: new Vec3(0, 107, 0) });
  bot.activateBlock = async () => { activated = true; };
  bot._client = { write(name) {
    if (name === 'block_dig') leftClickSent = true;
    if (name === 'block_place' || name === 'use_item') packetSent = true;
  } };
  bot.supportFeature = () => true;
  bot.setControlState = (name, state) => controls.push([name, state]);
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  await printer.handleCheckpoint({
    action: 'waterBucketPickup',
    target: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    goal: { x: 0.5, y: 108.5, z: 0.5 }
  });

  assert.equal(activated, false);
  assert.equal(packetSent, false);
  assert.equal(leftClickSent, true);
  assert.equal(printer.lastInteractPreferActivate, false);
  assert.equal(printer.state, 'AwaitAreaClear');
  assert.equal(controls.some(([name, state]) => name === 'sneak' && state === true), false);
});

test('water dispenser open tries literal left-click fallback after use packets fail', async () => {
  const cells = emptyCells();
  const writes = [];
  const warnings = [];
  const bot = fakeBot();
  bot._client = { write: (name, packet) => writes.push([name, packet]) };
  bot.supportFeature = (name) => name === 'blockPlaceHasInsideBlock';
  bot.activateBlock = async () => {};
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.warn = (message) => warnings.push(message);
  const block = { name: 'dispenser', position: new Vec3(0, 107, 0) };
  const config = printer.settings;
  config.waterDrainOpenTimeoutMs = 1;

  await printer.tryOpenContainerBlock(block, new Vec3(0, 1, 0));

  assert.equal(writes.some(([name]) => name === 'block_place'), true);
  assert.equal(writes.some(([name]) => name === 'block_dig'), true);
  assert.equal(warnings.some((message) => message.includes('literal left-click')), true);
});

test('failed water pickup open skips source without arming generic retry', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  let activated = false;
  bot.activateBlock = async () => { activated = true; };
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.tryOpenContainerBlock = async () => ({ status: 'failed' });
  printer.state = 'AwaitWaterBucketPickup';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    access: 'top'
  };

  await printer.interactWithBlock({ x: 0, y: 107, z: 0 }, {
    preferActivate: true,
    preferContainerOpen: true,
    recoveryCheckpoint: {
      goal: { x: 0.5, y: 108.5, z: 0.5 },
      action: 'waterBucketPickup',
      target: { x: 0, y: 108, z: 0 },
      dispenser: { x: 0, y: 107, z: 0 },
      access: 'top'
    }
  });

  assert.equal(activated, false);
  assert.equal(printer.state, 'AwaitAreaClear');
  assert.equal(printer.lastInteractedBlockPos, null);
  assert.equal(printer.interactTimeoutTicks, 0);
  assert.equal(printer.waterMissingBucketSources.has('0,108,0'), true);
});

test('failed water store open skips retry loop without extra activateBlock followup', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  let activated = false;
  bot.activateBlock = async () => { activated = true; };
  bot.inventory.items = () => [];
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.tryOpenContainerBlock = async () => ({ status: 'failed' });
  printer.state = 'AwaitWaterBucketStore';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    access: 'top'
  };

  await printer.interactWithBlock({ x: 0, y: 107, z: 0 }, {
    preferActivate: true,
    preferContainerOpen: true,
    recoveryCheckpoint: {
      goal: { x: 0.5, y: 108.5, z: 0.5 },
      action: 'waterBucketStore',
      target: { x: 0, y: 108, z: 0 },
      dispenser: { x: 0, y: 107, z: 0 },
      access: 'top'
    }
  });

  assert.equal(activated, false);
  assert.equal(printer.state, 'AwaitAreaClear');
  assert.equal(printer.lastInteractedBlockPos, null);
  assert.equal(printer.interactTimeoutTicks, 0);
  assert.equal(printer.waterDrainCurrent, null);
});

test('skipped water in AwaitAreaClear restores saved print path instead of blocking', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) {
      return { name: 'water', position: new Vec3(0, 108, 0), properties: { level: 0 } };
    }
    if (pos.x === 0 && pos.y === 107 && pos.z === 0) {
      return { name: 'dispenser', position: new Vec3(0, 107, 0) };
    }
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.drainResetWater = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitAreaClear';
  printer.waterMissingBucketSources.add('0,108,0');
  printer.waterResumeState = {
    reason: 'visible water interrupt',
    state: 'Walking',
    checkpoints: [
      { goal: { x: 1.5, y: 108, z: 1.5 }, action: 'sprint' },
      { goal: { x: 1.5, y: 108, z: 127.5 }, action: 'lineEnd' }
    ],
    checkpointKey: 'old',
    checkpointBestDistance: 3,
    checkpointAxis: 'z',
    checkpointAxisOffset: 0,
    lastWalkingProgressAt: Date.now() - 1000
  };

  await printer.tick();

  assert.equal(printer.state, 'Walking');
  assert.equal(printer.waterResumeState, null);
  assert.equal(printer.waterMissingBucketSources.has('0,108,0'), true);
  assert.deepEqual(printer.checkpoints.map((checkpoint) => checkpoint.action), ['sprint', 'lineEnd']);
});

test('multiple skipped water sources stay skipped and do not re-interrupt printing', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if ((pos.x === 0 || pos.x === 1) && pos.y === 108 && pos.z === 0) {
      return { name: 'water', position: new Vec3(pos.x, 108, 0), properties: { level: 0 } };
    }
    if ((pos.x === 0 || pos.x === 1) && pos.y === 107 && pos.z === 0) {
      return { name: 'dispenser', position: new Vec3(pos.x, 107, 0) };
    }
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.drainResetWater = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitAreaClear';
  printer.waterMissingBucketSources.add('0,108,0');
  printer.waterMissingBucketSources.add('1,108,0');
  printer.waterResumeState = {
    reason: 'visible water interrupt',
    state: 'Walking',
    checkpoints: [{ goal: { x: 2.5, y: 108, z: 2.5 }, action: 'sprint' }],
    checkpointKey: null,
    checkpointBestDistance: 1,
    checkpointAxis: null,
    checkpointAxisOffset: null,
    lastWalkingProgressAt: Date.now()
  };

  await printer.tick();

  assert.equal(printer.state, 'Walking');
  assert.equal(printer.waterMissingBucketSources.has('0,108,0'), true);
  assert.equal(printer.waterMissingBucketSources.has('1,108,0'), true);
  assert.equal(printer.queueVisibleWaterDrainIfNeeded(), false);
  assert.equal(printer.state, 'Walking');
});

test('skipped water without print resume falls through normal area-clear flow', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) {
      return { name: 'water', position: new Vec3(0, 108, 0), properties: { level: 0 } };
    }
    if (pos.x === 0 && pos.y === 107 && pos.z === 0) {
      return { name: 'dispenser', position: new Vec3(0, 107, 0) };
    }
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.drainResetWater = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitAreaClear';
  printer.waterMissingBucketSources.add('0,108,0');
  printer.mapAreaClearStatus = () => ({ clear: true, blocker: null, unknown: 0 });

  await printer.tick();

  assert.equal(printer.state, 'AwaitNBTFile');
});

test('water pickup dumps one carpet stack when inventory is full', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  const tossed = [];
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.tossStack = async (stack) => tossed.push(stack.name);
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.state = 'AwaitWaterBucketPickup';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 }
  };
  const window = {
    inventoryStart: 9,
    slots: [
      item('bucket', 1, 0),
      null, null, null, null, null, null, null, null,
      ...Array.from({ length: 36 }, (_, index) => item('red_carpet', 64, 9 + index))
    ]
  };

  await printer.handleInventoryWindow(window);
  assert.equal(printer.state, 'Walking');
  assert.deepEqual(tossed, ['red_carpet']);
  assert.equal(printer.checkpoints[0].action, 'waterBucketPickup');
});

test('water pickup blocks when inventory full and no carpet can be tossed', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  bot.inventory.slots[36] = item('diamond_pickaxe', 1, 36);
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];

  await printer.handleCheckpoint({
    action: 'waterBucketPickup',
    target: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    goal: { x: 0.5, y: 108.5, z: 0.5 }
  });

  assert.equal(printer.state, 'WaterDrainBlocked');
});

test('water pickup enters recovery when dispenser contains water_bucket', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  bot.inventory.items = () => [];
  bot.clickWindow = async () => {};
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.state = 'AwaitWaterBucketPickup';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    access: 'under'
  };
  const window = {
    inventoryStart: 9,
    slots: [
      item('water_bucket', 1, 0),
      null, null, null, null, null, null, null, null,
      null,
      ...Array.from({ length: 35 }, (_, index) => item('red_carpet', 64, 10 + index))
    ]
  };

  await printer.handleInventoryWindow(window);

  assert.equal(printer.state, 'WaterBucketRecover');
  assert.equal(printer.waterDrainCurrent.recovering, true);
});

test('water drain uses packet bucket interact before Mineflayer fallback', async () => {
  const cells = emptyCells();
  let hasWater = true;
  let held = 'bucket';
  const writes = [];
  const controls = [];
  const bot = fakeBot();
  bot.inventory.items = () => held === 'bucket' ? [item('bucket', 1, 36)] : [item('water_bucket', 1, 36)];
  bot.equip = async (stack) => { held = stack.name; };
  bot.lookAt = async () => {};
  bot._client = {
    write(name) {
      writes.push(name);
      if (name === 'block_place' || name === 'use_item') {
        hasWater = false;
        held = 'water_bucket';
      }
    }
  };
  bot.setControlState = (name, state) => controls.push([name, state]);
  bot.supportFeature = (name) => name === 'blockPlaceHasInsideBlock';
  bot.activateBlock = async () => {};
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) {
      return { name: hasWater ? 'water' : 'air', position: new Vec3(0, 108, 0), properties: hasWater ? { level: 0 } : undefined };
    }
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.waterDrainActionDelayMs = 0;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'WaterBucketDrain';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 }
  };

  await printer.tickWaterBucketDrain();

  assert.equal(writes.includes('block_place'), true);
  assert.equal(writes.includes('block_dig'), false);
  assert.equal(printer.checkpoints[0].action, 'waterBucketStore');
  assert.deepEqual(controls.filter(([name]) => name === 'sneak'), [['sneak', true], ['sneak', false]]);
});

test('water bucket recover converts held water_bucket into empty bucket and resumes drain', async () => {
  const cells = emptyCells();
  let held = 'water_bucket';
  const writes = [];
  const bot = fakeBot();
  bot.inventory.items = () => [item(held, 1, 36)];
  bot.equip = async (stack) => { held = stack.name; };
  bot.lookAt = async () => {};
  bot._client = {
    write(name) {
      writes.push(name);
      if (name === 'block_place') held = 'bucket';
    }
  };
  bot.supportFeature = (name) => name === 'blockPlaceHasInsideBlock';
  bot.activateBlock = async () => { held = 'bucket'; };
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 107 && pos.z === 0) {
      return { name: 'dispenser', position: new Vec3(0, 107, 0) };
    }
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) {
      return { name: 'water', position: new Vec3(0, 108, 0), properties: { level: 0 } };
    }
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.waterDrainActionDelayMs = 0;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'WaterBucketRecover';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    access: 'under'
  };

  await printer.tickWaterBucketRecover();

  assert.equal(writes.includes('block_place'), true);
  assert.equal(printer.state, 'WaterBucketDrain');
});

test('water drain does not store bucket until source clears or fails', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  bot.inventory.items = () => [item('bucket', 1, 36)];
  bot.equip = async () => {};
  bot.lookAt = async () => {};
  bot.activateBlock = async () => {};
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) {
      return { name: 'water', position: new Vec3(0, 108, 0), properties: { level: 0 } };
    }
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.waterDrainActionDelayMs = 0;
  config.printer.waterDrainVerifyMs = 0;
  config.printer.waterDrainVerifyChecks = 2;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'WaterBucketDrain';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 }
  };

  await printer.tickWaterBucketDrain();

  assert.equal(printer.state, 'WaterDrainBlocked');
  assert.equal(printer.checkpoints.length, 0);
});

test('water drain blocks when bucket pickup does not clear source', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  let held = 'bucket';
  bot.inventory.items = () => [item(held, 1, 36)];
  bot.equip = async (stack) => { held = stack.name; };
  bot.lookAt = async () => {};
  bot.activateBlock = async () => { held = 'water_bucket'; };
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) {
      return { name: 'water', position: new Vec3(0, 108, 0), properties: { level: 0 } };
    }
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.waterDrainActionDelayMs = 0;
  config.printer.waterDrainVerifyMs = 0;
  config.printer.waterDrainVerifyChecks = 2;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'WaterBucketDrain';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 }
  };

  await printer.tickWaterBucketDrain();

  assert.equal(printer.state, 'WaterDrainBlocked');
  assert.equal(printer.checkpoints.length, 0);
});

test('water drain store verify treats dispenser bucket as success', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  const inventory = [item('water_bucket', 1, 36)];
  bot.inventory.items = () => inventory;
  bot.clickWindow = async () => {};
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitWaterBucketStore';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    access: 'top'
  };
  const window = {
    inventoryStart: 9,
    slots: [
      item('bucket', 1, 0),
      null, null, null, null, null, null, null, null,
      item('water_bucket', 1, 9),
      ...Array.from({ length: 35 }, (_, index) => item('red_carpet', 64, 10 + index))
    ]
  };

  await printer.handleInventoryWindow(window);

  assert.equal(printer.waterDrainCurrent, null);
  assert.equal(printer.state, 'AwaitAreaClear');
});

test('water drain store verify enters recovery when dispenser still has water_bucket', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  const inventory = [item('water_bucket', 1, 36)];
  bot.inventory.items = () => inventory;
  bot.clickWindow = async () => {};
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitWaterBucketStore';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    access: 'under'
  };
  const window = {
    inventoryStart: 9,
    slots: [
      item('water_bucket', 1, 0),
      null, null, null, null, null, null, null, null,
      item('water_bucket', 1, 9),
      ...Array.from({ length: 35 }, (_, index) => item('red_carpet', 64, 10 + index))
    ]
  };

  await printer.handleInventoryWindow(window);

  assert.equal(printer.state, 'WaterBucketRecover');
  assert.equal(printer.waterDrainCurrent.recovering, true);
});

test('water dispenser open respects bounded max attempts', async () => {
  const cells = emptyCells();
  const writes = [];
  const bot = fakeBot();
  bot._client = { write: (name, packet) => writes.push([name, packet]) };
  bot.supportFeature = (name) => name === 'blockPlaceHasInsideBlock';
  bot.activateBlock = async () => {};
  const config = fakeConfig();
  config.printer.waterDrainOpenTimeoutMs = 10000;
  config.printer.waterDrainOpenMaxAttempts = 4;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  const block = { name: 'dispenser', position: new Vec3(0, 107, 0) };

  await printer.tryOpenContainerBlock(block, new Vec3(0, 1, 0));

  assert.equal(writes.filter(([name]) => name === 'block_place').length, 6);
});

test('last water source cleanup restores print queue instead of parking in AwaitAreaClear', async () => {
  const cells = emptyCells();
  const bot = fakeBot();
  const inventory = [item('water_bucket', 1, 36)];
  bot.inventory.items = () => inventory;
  bot.clickWindow = async () => {};
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) {
      return { name: 'air' };
    }
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.printer.waterDrainActionDelayMs = 0;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitWaterBucketStore';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    access: 'top'
  };
  printer.waterResumeState = {
    reason: 'visible water interrupt',
    state: 'Walking',
    checkpoints: [
      { goal: { x: 0.5, y: 108, z: 0.5 }, action: 'sprint' },
      { goal: { x: 0.5, y: 108, z: 127.5 }, action: 'lineEnd' }
    ],
    checkpointKey: 'sprint:0.500,0.500',
    checkpointBestDistance: 1,
    checkpointAxis: 'z',
    checkpointAxisOffset: 0,
    lastWalkingProgressAt: Date.now() - 1000
  };
  printer.checkpoints = [
    { goal: { x: 9.5, y: 108, z: 9.5 }, action: 'waterBucketStore' }
  ];
  const window = {
    inventoryStart: 9,
    slots: [
      null, null, null, null, null, null, null, null, null,
      item('water_bucket', 1, 9),
      ...Array.from({ length: 36 }, (_, index) => (index === 0 ? null : item('red_carpet', 64, 10 + index)))
    ]
  };

  await printer.handleInventoryWindow(window);

  assert.equal(printer.state, 'Walking');
  assert.equal(printer.waterResumeState, null);
  assert.deepEqual(printer.checkpoints.map((checkpoint) => checkpoint.action), ['sprint', 'lineEnd']);
});

test('anti velocity tick guard zeros velocity during reset-water states', async () => {
  const bot = fakeBot();
  bot.entity.velocity = new Vec3(3, 1, -2);
  const config = fakeConfig();
  config.printer.antiVelocity = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitAreaClear';

  await printer.tick();

  assert.deepEqual(bot.entity.velocity, new Vec3(0, 0, 0));
});

test('anti velocity liquid mode anchors water drain interaction position', async () => {
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 3.5);
  bot.entity.velocity = new Vec3(0, 0, 2);
  bot._client = { write: () => {} };
  bot.supportFeature = () => true;
  const config = fakeConfig();
  config.printer.antiVelocity = true;
  config.printer.antiVelocityLiquid = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'WaterBucketDrain';
  printer.waterDrainCurrent = {
    source: { x: 0, y: 108, z: 0 },
    dispenser: { x: 0, y: 107, z: 0 },
    access: 'top'
  };

  const anchored = printer.zeroVelocityForResetWater();

  assert.equal(anchored, true);
  assert.deepEqual(bot.entity.velocity, new Vec3(0, 0, 0));
  assert.deepEqual(bot.entity.position, new Vec3(0.5, 108, 0.5));
});

test('tickWalking holds sealed movement when an open planned cell is near range edge', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const controls = [];
  let sends = 0;
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 4.5);
  bot.setControlState = (control, state) => controls.push([control, state]);
  bot.heldItem = { name: 'red_carpet' };
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.inventory.items = () => [{ name: 'red_carpet', count: 64 }];
  bot.blockAt = (pos) => {
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air' };
  };
  bot._genericPlace = async () => { sends += 1; };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  config.printer.backfillEdgeBuffer = 1;
  config.printer.holdOpenEdge = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.checkpoints = [{ goal: { x: 0.5, y: 108, z: 127.5 }, action: 'lineEnd' }];

  await printer.tickWalking(0);

  assert.deepEqual(controls, [['forward', false], ['sprint', false]]);
  assert.equal(sends, 1);
});

test('tryPlacingBlock force-enables packet-only sneak for clickable below supports', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const writes = [];
  const controls = [];
  const bot = fakeBot();
  bot.heldItem = { name: 'red_carpet' };
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.inventory.items = () => [{ name: 'red_carpet', count: 64 }];
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 107 && pos.z === 0) return { name: 'dispenser', position: new Vec3(0, 107, 0) };
    return { name: 'air' };
  };
  bot.lookAt = async () => {};
  bot.getControlState = () => false;
  bot.setControlState = (control, state) => controls.push([control, state]);
  bot.swingArm = () => {};
  bot.supportFeature = (name) => name === 'blockPlaceHasInsideBlock';
  bot._client = {
    write(name, packet) {
      writes.push([name, packet]);
    }
  };
  const config = fakeConfig();
  config.printer.sneakPlace = false;
  config.printer.packetSneakPlace = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];

  await assert.doesNotReject(() => printer.tryPlacingBlock({ x: 0, y: 108, z: 0 }));
  assert.deepEqual(controls, []);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map(([name]) => name), ['entity_action', 'block_place', 'entity_action']);
  assert.equal(writes[0][1].actionId, 0);
  assert.equal(writes[1][1].direction, 1);
  assert.equal(writes[1][1].cursorY, 1);
  assert.equal(writes[2][1].actionId, 1);
  assert.equal(printer.placementReferenceStats.packetSneak, 1);
  assert.equal(printer.placementReferenceStats.controlSneak, 0);
  assert.equal(printer.placementReferenceStats.clickableBelow, 1);
});

test('tryPlacingBlock avoids sneak by using adjacent carpet as addon-style place side', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const writes = [];
  const controls = [];
  const bot = fakeBot();
  bot.heldItem = { name: 'red_carpet' };
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.inventory.items = () => [{ name: 'red_carpet', count: 64 }];
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 107 && pos.z === 0) return { name: 'dispenser', position: new Vec3(0, 107, 0) };
    if (pos.x === -1 && pos.y === 108 && pos.z === 0) return { name: 'black_carpet', position: new Vec3(-1, 108, 0) };
    return { name: 'air' };
  };
  bot.getControlState = () => false;
  bot.setControlState = (control, state) => controls.push([control, state]);
  bot.swingArm = () => {};
  bot.supportFeature = (name) => name === 'blockPlaceHasInsideBlock';
  bot._client = {
    write(name, packet) {
      writes.push([name, packet]);
    }
  };
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];

  await assert.doesNotReject(() => printer.tryPlacingBlock({ x: 0, y: 108, z: 0 }));
  assert.deepEqual(controls, []);
  assert.deepEqual(writes.map(([name]) => name), ['block_place']);
  assert.equal(writes[0][1].direction, 5);
  assert.equal(writes[0][1].cursorX, 1);
  assert.equal(printer.placementReferenceStats.packetSneak, 0);
  assert.equal(printer.placementReferenceStats.controlSneak, 0);
  assert.equal(printer.placementReferenceStats.clickableBelow, 0);
});

test('tickWalking retries a pending hole over clickable support with packet sneak', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const writes = [];
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 2.5);
  bot.heldItem = { name: 'red_carpet' };
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.inventory.items = () => [{ name: 'red_carpet', count: 64 }];
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 107 && pos.z === 0) return { name: 'dispenser', position: new Vec3(0, 107, 0) };
    return { name: 'air' };
  };
  bot.swingArm = () => {};
  bot.supportFeature = (name) => name === 'blockPlaceHasInsideBlock';
  bot._client = {
    write(name, packet) {
      writes.push([name, packet]);
    }
  };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  config.printer.placementRetries = 20;
  config.printer.sneakPlace = false;
  config.printer.packetSneakPlace = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.checkpoints = [{ goal: { x: 0.5, y: 108, z: 127.5 }, action: 'lineEnd' }];
  printer.pendingPlacements.set('0,108,0', {
    pos: { x: 0, y: 108, z: 0 },
    material: 'red_carpet',
    attempts: 1,
    nextRetryAt: Date.now() - 1
  });

  await printer.tickWalking(1);

  assert.deepEqual(writes.map(([name]) => name).slice(-3), ['entity_action', 'block_place', 'entity_action']);
  assert.equal(writes.at(-3)[1].actionId, 0);
  assert.equal(writes.at(-1)[1].actionId, 1);
  assert.equal(printer.pendingPlacements.get('0,108,0').attempts, 2);
  assert.equal(printer.placementReferenceStats.packetSneak, 1);
});

test('handleInventoryWindow queues only full matching restock stacks', async () => {
  const bot = fakeBot();
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitRestockResponse';
  printer.restockList = [{ itemName: 'red_carpet', stacks: 2, rawAmount: 100 }];
  const window = {
    inventoryStart: 4,
    slots: [
      item('red_carpet', 64, 0),
      item('red_carpet', 32, 1),
      item('blue_carpet', 64, 2),
      item('red_carpet', 64, 3),
      ...Array.from({ length: 36 }, () => null)
    ]
  };

  await printer.handleInventoryWindow(window);

  assert.equal(printer.restockBacklogSlots.length, 2);
  assert.equal(printer.restockList[0].stacks, 0);
  assert.equal(printer.restockList[0].rawAmount, -28);
});

test('handleInventoryWindow can restock into partial matching stack when no slots are empty', async () => {
  const bot = fakeBot();
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitRestockResponse';
  printer.restockList = [{ itemName: 'red_carpet', stacks: 1, rawAmount: 40 }];
  const playerSlots = Array.from({ length: 36 }, (_, index) => item('blue_carpet', 64, 4 + index));
  playerSlots[35] = item('red_carpet', 12, 39);
  const window = {
    inventoryStart: 4,
    slots: [
      item('red_carpet', 64, 0),
      item('red_carpet', 64, 1),
      item('blue_carpet', 64, 2),
      item('blue_carpet', 64, 3),
      ...playerSlots
    ]
  };

  await printer.handleInventoryWindow(window);

  assert.equal(printer.restockBacklogSlots.length, 1);
  assert.equal(printer.restockList[0].stacks, 0);
});

test('getDumpSlot uses addon required-items window', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const bot = fakeBot();
  bot.inventory.slots[36] = item('blue_carpet', 64, 36);
  bot.inventory.slots[37] = item('black_carpet', 64, 37);
  const config = fakeConfig();
  config.printer.restockSlotMode = 'addon';
  config.nerv.carpetConfig.materialChests.black_carpet = [config.nerv.carpetConfig.reset];
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1];
  printer.availableHotBarSlots = [0, 1];
  printer.restockList = [{ itemName: 'black_carpet', stacks: 1, rawAmount: 11 }];

  assert.equal(printer.getDumpSlot(), 0);
  assert.equal(printer.stackInJavaSlot(printer.getDumpSlot()).name, 'blue_carpet');
});

test('restock routing chooses closest material like the addon', () => {
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.black_carpet = [{
    blockPos: { x: 20, y: 108, z: 1 },
    openPos: { x: 20.5, y: 108, z: 1.5 }
  }];
  config.nerv.carpetConfig.materialChests.pink_carpet = [{
    blockPos: { x: 2, y: 108, z: 1 },
    openPos: { x: 2.5, y: 108, z: 1.5 }
  }];
  const bot = fakeBot();
  bot.entity.position = new Vec3(1.5, 108, 1.5);
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1];
  printer.restockList = [
    { itemName: 'pink_carpet', stacks: 1, rawAmount: 64 },
    { itemName: 'black_carpet', stacks: 1, rawAmount: 11 }
  ];

  printer.addClosestRestockCheckpoint();

  assert.equal(printer.restockList[0].itemName, 'pink_carpet');
  assert.equal(printer.checkpoints[0].action, 'refill');
});

test('getInventoryMaterialInfo mirrors addon dump-slot decisions', () => {
  const bot = fakeBot();
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  bot.inventory.slots[37] = item('blue_carpet', 64, 37);
  bot.inventory.slots[9] = item('pink_carpet', 64, 9);
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1, 9];
  const required = new Map([['red_carpet', 63], ['blue_carpet', 65]]);

  const info = printer.getInventoryMaterialInfo(required);

  assert.deepEqual(info.dumpSlots, [9]);
  assert.deepEqual([...info.counts.entries()], [['red_carpet', 64], ['blue_carpet', 64]]);
});

test('setupSlots full mode uses all 36 player inventory slots', () => {
  const bot = fakeBot();
  bot.inventory.slots[36] = item('diamond_pickaxe', 1, 36);
  bot.inventory.slots[10] = item('totem_of_undying', 1, 10);
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  printer.setupSlots();

  assert.deepEqual(printer.availableSlots, Array.from({ length: 36 }, (_, index) => index));
  assert.deepEqual(printer.availableHotBarSlots, Array.from({ length: 9 }, (_, index) => index));
});

test('setupSlots addon mode uses only empty or material slots', () => {
  const bot = fakeBot();
  bot.inventory.slots[36] = item('diamond_pickaxe', 1, 36);
  bot.inventory.slots[37] = item('red_carpet', 64, 37);
  const config = fakeConfig();
  config.printer.restockSlotMode = 'addon';
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  printer.setupSlots();

  assert.equal(printer.availableSlots.includes(0), false);
  assert.equal(printer.availableSlots.includes(1), true);
});

test('full mode dumps non-carpet items from build slots', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const bot = fakeBot();
  bot.inventory.slots[36] = item('diamond_pickaxe', 1, 36);
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  printer.setupSlots();

  assert.equal(printer.getDumpSlot(), 0);
});

test('full restock planning uses 36-stack capacity', () => {
  const cells = emptyCells();
  for (let x = 0; x < 128; x += 1) {
    for (let z = 0; z < 128; z += 1) cells[x][z] = 'red_carpet';
  }
  const printer = new NervCarpetPrinter(fakeBot(), fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  printer.setupSlots();
  const target = printer.getRequiredItems();

  assert.equal(stacksRequired(target.values()), 36);
  assert.equal(target.get('red_carpet'), 36 * 64);
});

test('addon restock dumps future colors outside the next capacity window', () => {
  const cells = emptyCells();
  for (let z = 0; z < 120; z += 1) cells[0][z] = 'red_carpet';
  cells[0][120] = 'blue_carpet';
  const bot = fakeBot();
  bot.inventory.slots[36] = item('blue_carpet', 64, 36);
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1];
  printer.availableHotBarSlots = [0, 1];

  assert.equal(printer.getDumpSlot(), 0);
  assert.deepEqual([...printer.getRequiredItems().entries()], [
    ['red_carpet', 120],
    ['blue_carpet', 0]
  ]);
});

test('addon restock fills inventory by upcoming print order', () => {
  const cells = emptyCells();
  for (let z = 0; z < 128; z += 1) cells[0][z] = 'red_carpet';
  cells[1][0] = 'blue_carpet';
  cells[1][1] = 'black_carpet';
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.black_carpet = [config.nerv.carpetConfig.reset];
  const printer = new NervCarpetPrinter(fakeBot(), config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1, 2];
  printer.availableHotBarSlots = [0, 1, 2];

  printer.refillInventory(new Map());

  assert.equal(printer.restockList.some((entry) => entry.itemName === 'red_carpet'), true);
  assert.equal(stacksRequired(printer.restockList.map((entry) => entry.rawAmount)), 3);
});

test('restock target rounds every chosen material to full stacks', () => {
  const cells = emptyCells();
  cells[0][0] = 'yellow_carpet';
  for (let z = 1; z < 20; z += 1) cells[0][z] = 'pink_carpet';
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.yellow_carpet = [config.nerv.carpetConfig.reset];
  config.nerv.carpetConfig.materialChests.pink_carpet = [config.nerv.carpetConfig.reset];
  const printer = new NervCarpetPrinter(fakeBot(), config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1];
  printer.availableHotBarSlots = [0, 1];

  const target = printer.getRestockTargetItems();

  assert.equal(target.get('yellow_carpet'), 64);
  assert.equal(target.get('pink_carpet'), 64);
});

test('full restock keeps carried future carpet in spare slots', () => {
  const cells = emptyCells();
  cells[0][0] = 'yellow_carpet';
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.yellow_carpet = [config.nerv.carpetConfig.reset];
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const bot = fakeBot();
  bot.inventory.slots[36] = item('gray_carpet', 64, 36);
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1];
  printer.availableHotBarSlots = [0, 1];

  const target = printer.getRestockTargetItems();

  assert.equal(target.get('yellow_carpet'), 64);
  assert.equal(target.get('gray_carpet'), 64);
  assert.equal(stacksRequired(target.values()), 2);
  assert.equal(printer.getDumpSlot(), -1);
});

test('full restock tops spare slots from later unfinished materials', () => {
  const cells = emptyCells();
  cells[0][0] = 'yellow_carpet';
  cells[10][10] = 'gray_carpet';
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.yellow_carpet = [config.nerv.carpetConfig.reset];
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const printer = new NervCarpetPrinter(fakeBot(), config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1];
  printer.availableHotBarSlots = [0, 1];

  const target = printer.getRestockTargetItems();

  assert.equal(target.get('yellow_carpet'), 64);
  assert.equal(target.get('gray_carpet'), 64);
  assert.equal(stacksRequired(target.values()), 2);
});

test('full restock can use spare slots as packet-safety backups', () => {
  const cells = emptyCells();
  for (let z = 0; z < 128; z += 1) cells[0][z] = 'pink_carpet';
  for (let z = 0; z < 128; z += 1) cells[1][z] = 'yellow_carpet';
  for (let z = 0; z < 128; z += 1) cells[2][z] = 'orange_carpet';
  cells[3][0] = 'black_carpet';
  cells[3][1] = 'red_carpet';
  cells[3][2] = 'brown_carpet';
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.pink_carpet = [config.nerv.carpetConfig.reset];
  config.nerv.carpetConfig.materialChests.yellow_carpet = [config.nerv.carpetConfig.reset];
  config.nerv.carpetConfig.materialChests.orange_carpet = [config.nerv.carpetConfig.reset];
  config.nerv.carpetConfig.materialChests.black_carpet = [config.nerv.carpetConfig.reset];
  config.nerv.carpetConfig.materialChests.red_carpet = [config.nerv.carpetConfig.reset];
  config.nerv.carpetConfig.materialChests.brown_carpet = [config.nerv.carpetConfig.reset];
  const printer = new NervCarpetPrinter(fakeBot(), config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  printer.availableHotBarSlots = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  const target = printer.getRestockTargetItems();

  assert.equal(stacksRequired(target.values()), 12);
  assert.equal(target.get('black_carpet'), 128);
  assert.equal(target.get('red_carpet'), 128);
  assert.equal(target.get('brown_carpet'), 128);
});

test('full restock adds missing future colors before duplicate backup stacks', () => {
  const cells = emptyCells();
  for (let z = 0; z < 128; z += 1) cells[0][z] = 'pink_carpet';
  for (let z = 0; z < 128; z += 1) cells[1][z] = 'orange_carpet';
  cells[2][0] = 'black_carpet';
  cells[20][0] = 'gray_carpet';
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.pink_carpet = [config.nerv.carpetConfig.reset];
  config.nerv.carpetConfig.materialChests.orange_carpet = [config.nerv.carpetConfig.reset];
  config.nerv.carpetConfig.materialChests.black_carpet = [config.nerv.carpetConfig.reset];
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const printer = new NervCarpetPrinter(fakeBot(), config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1, 2, 3, 4, 5, 6];
  printer.availableHotBarSlots = [0, 1, 2, 3, 4, 5, 6];

  const target = printer.getRestockTargetItems();

  assert.equal(stacksRequired(target.values()), 7);
  assert.equal(target.get('gray_carpet'), 64);
  assert.equal(target.get('black_carpet'), 128);
});

test('full restock gives spare slots to highest confirmed remaining demand', () => {
  const cells = emptyCells();
  for (let z = 0; z < 300; z += 1) cells[Math.floor(z / 128)][z % 128] = 'black_carpet';
  for (let z = 0; z < 80; z += 1) cells[3][z] = 'pink_carpet';
  cells[4][0] = 'gray_carpet';
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.black_carpet = [config.nerv.carpetConfig.reset];
  config.nerv.carpetConfig.materialChests.pink_carpet = [config.nerv.carpetConfig.reset];
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const printer = new NervCarpetPrinter(fakeBot(), config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1, 2, 3, 4, 5, 6, 7];
  printer.availableHotBarSlots = [0, 1, 2, 3, 4, 5, 6, 7];

  const target = printer.getRestockTargetItems();

  assert.equal(stacksRequired(target.values()), 8);
  assert.equal(target.get('black_carpet'), 320);
  assert.equal(target.get('pink_carpet'), 128);
  assert.equal(target.get('gray_carpet'), 64);
});

test('restock planning counts real air even when optimistic placement exists', () => {
  const cells = emptyCells();
  cells[0][0] = 'gray_carpet';
  const config = fakeConfig();
  config.printer.restockSlotMode = 'addon';
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: 'air' };
    return { name: 'stone' };
  };
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.optimisticPlacements.set('0,108,0', {
    material: 'gray_carpet',
    expiresAt: Date.now() + 10000
  });

  assert.equal(printer.getRestockTargetItems().has('gray_carpet'), false);
  assert.equal(printer.getActiveRestockTargetItems().get('gray_carpet'), 64);
});

test('restock dump and refill reuse a frozen target even if world state changes', () => {
  const cells = emptyCells();
  cells[0][0] = 'gray_carpet';
  const config = fakeConfig();
  config.printer.restockSlotMode = 'addon';
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const bot = fakeBot();
  let placed = false;
  bot.inventory.slots[36] = item('blue_carpet', 64, 36);
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: placed ? 'gray_carpet' : 'air' };
    return { name: 'stone' };
  };
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];

  assert.equal(printer.getDumpSlot(), 0);
  placed = true;
  printer.refillInventory(new Map());

  assert.equal(printer.restockList.length, 1);
  assert.equal(printer.restockList[0].itemName, 'gray_carpet');
});

test('dump completion uses frozen active restock target', async () => {
  const cells = emptyCells();
  cells[0][0] = 'gray_carpet';
  const config = fakeConfig();
  config.printer.restockSlotMode = 'addon';
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const bot = fakeBot();
  let placed = false;
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: placed ? 'gray_carpet' : 'air' };
    return { name: 'stone' };
  };
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.getActiveRestockTargetItems();
  placed = true;
  printer.state = 'Dumping';

  await printer.tickDumping();

  assert.equal(printer.restockList.length, 1);
  assert.equal(printer.restockList[0].itemName, 'gray_carpet');
});

test('post-restock clears stale optimistic air without dropping pending retry', () => {
  const cells = emptyCells();
  cells[0][0] = 'gray_carpet';
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: 'air' };
    return { name: 'stone' };
  };
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.pendingPlacements.set('0,108,0', {
    pos: { x: 0, y: 108, z: 0 },
    material: 'gray_carpet',
    attempts: 1,
    nextRetryAt: Date.now() - 1
  });
  printer.optimisticPlacements.set('0,108,0', {
    material: 'gray_carpet',
    expiresAt: Date.now() + 10000
  });

  const cleared = printer.clearOpenOptimisticPlacements();

  assert.equal(cleared, 1);
  assert.equal(printer.optimisticPlacements.has('0,108,0'), false);
  assert.equal(printer.pendingPlacements.has('0,108,0'), true);
});

test('post-restock restores saved print queue instead of world-scan rebuild', () => {
  const cells = emptyCells();
  cells[0][0] = 'gray_carpet';
  const bot = fakeBot();
  bot.inventory.slots[36] = item('gray_carpet', 64, 36);
  bot.inventory.items = () => [item('gray_carpet', 64, 36)];
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: 'air' };
    if (pos.y === 107) return { name: 'stone', position: new Vec3(pos.x, pos.y, pos.z) };
    return { name: 'air' };
  };
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.restockTargetItems = new Map([['gray_carpet', 64]]);
  printer.restockList = [{ itemName: 'gray_carpet', stacks: 0, rawAmount: 0 }];
  printer.checkpoints = [
    { goal: { x: 0.5, y: 108, z: 0.5 }, action: 'sprint' },
    { goal: { x: 0.5, y: 108, z: 127.5 }, action: 'lineEnd' }
  ];
  printer.restockResumeState = {
    reason: 'restock refill',
    checkpoints: [
      { goal: { x: 0.5, y: 108, z: 0.5 }, action: 'sprint' },
      { goal: { x: 0.5, y: 108, z: 127.5 }, action: 'lineEnd' },
      { goal: { x: 1.5, y: 108, z: 127.5 }, action: '' }
    ],
    checkpointKey: 'sprint:0.500,0.500',
    checkpointBestDistance: 5,
    checkpointAxis: 'z',
    checkpointAxisOffset: 0.5,
    lastWalkingProgressAt: Date.now() - 250
  };

  printer.endRestocking();

  assert.equal(printer.checkpoints[0].goal.x, 0.5);
  assert.equal(printer.checkpoints[0].goal.z, 0.5);
  assert.equal(printer.checkpoints[0].action, 'sprint');
  assert.equal(printer.checkpoints[1].action, 'lineEnd');
  assert.equal(printer.restockResumeState, null);
});

test('startBuilding clears stale restock resume state and starts from first print row', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const bot = fakeBot();
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.restockResumeState = {
    reason: 'stale',
    checkpoints: [{ goal: { x: 99, y: 108, z: 99 }, action: 'lineEnd' }],
    checkpointKey: 'old',
    checkpointBestDistance: 1,
    checkpointAxis: 'x',
    checkpointAxisOffset: 1,
    lastWalkingProgressAt: Date.now() - 1000
  };

  printer.startBuilding();

  assert.equal(printer.restockResumeState, null);
  assert.equal(printer.checkpoints[0].action, 'dump');
  assert.equal(printer.checkpoints[1].action, 'sprint');
  assert.equal(printer.checkpoints[1].goal.x, 0.5);
  assert.equal(printer.checkpoints[1].goal.z, 0.5);
});

test('partial carpet stack is dumped so restock refills a full stack', () => {
  const cells = emptyCells();
  cells[0][0] = 'yellow_carpet';
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.yellow_carpet = [config.nerv.carpetConfig.reset];
  const bot = fakeBot();
  bot.inventory.slots[36] = item('yellow_carpet', 14, 36);
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];

  assert.equal(printer.getDumpSlot(), 0);
});

test('addon restock follows upcoming order with no forced material injection', () => {
  const cells = emptyCells();
  cells[0][0] = 'gray_carpet';
  for (let z = 1; z < 128; z += 1) cells[0][z] = 'red_carpet';
  for (let z = 0; z < 128; z += 1) cells[1][z] = 'blue_carpet';
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const printer = new NervCarpetPrinter(fakeBot(), config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1];
  printer.availableHotBarSlots = [0, 1];

  const targets = printer.getRequiredItems();

  assert.equal(targets.has('gray_carpet'), true);
  assert.equal(targets.has('blue_carpet'), true);
  assert.equal(targets.get('red_carpet') || 0, 0);
});

test('missing placement material seeds restock target without changing addon required items', async () => {
  const cells = emptyCells();
  cells[0][0] = 'gray_carpet';
  for (let z = 1; z < 128; z += 1) cells[0][z] = 'red_carpet';
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 2.5);
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.checkpoints = [{ goal: { x: 0.5, y: 108, z: 127.5 }, action: 'lineEnd' }];

  await printer.tryPlacingBlock({ x: 0, y: 108, z: 0 });

  assert.equal(printer.checkpoints[0].action, 'dump');
  assert.equal(printer.checkpoints[1].action, 'sprint');
  assert.equal(printer.checkpoints[1].goal.z, -0.5);
  assert.equal(printer.getRequiredItems().has('gray_carpet'), true);
  assert.equal(printer.getRestockTargetItems().has('gray_carpet'), true);
  assert.equal(printer.restockSeedMaterials.has('gray_carpet'), true);
});

test('missing material hidden by optimistic placement is still restocked', async () => {
  const cells = emptyCells();
  cells[0][0] = 'gray_carpet';
  for (let z = 1; z < 128; z += 1) cells[0][z] = 'red_carpet';
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 2.5);
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.optimisticPlacements.set('0,108,0', {
    material: 'gray_carpet',
    expiresAt: Date.now() + 10000
  });

  assert.equal(printer.getRequiredItems().has('gray_carpet'), false);

  await printer.tryPlacingBlock({ x: 0, y: 108, z: 0 });

  assert.equal(printer.getRequiredItems().has('gray_carpet'), true);
  assert.equal(printer.getRestockTargetItems().get('gray_carpet'), 64);
  assert.equal(printer.optimisticPlacements.has('0,108,0'), false);
});

test('restock seed does not protect unrelated future colors', async () => {
  const cells = emptyCells();
  for (let z = 0; z < 120; z += 1) cells[0][z] = 'red_carpet';
  cells[0][120] = 'blue_carpet';
  cells[0][121] = 'gray_carpet';
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const bot = fakeBot();
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1];
  printer.availableHotBarSlots = [0, 1];
  printer.seedRestockMaterial('gray_carpet', { x: 0, y: 108, z: 121 });

  const target = printer.getRestockTargetItems();

  assert.equal(target.get('gray_carpet'), 64);
  assert.equal(target.get('blue_carpet') || 0, 0);
});

test('seeded restock target stays capped to slot capacity', () => {
  const cells = emptyCells();
  for (let z = 0; z < 64; z += 1) cells[0][z] = 'red_carpet';
  cells[0][64] = 'gray_carpet';
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const printer = new NervCarpetPrinter(fakeBot(), config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.seedRestockMaterial('gray_carpet', { x: 0, y: 108, z: 64 });

  const target = printer.getRestockTargetItems();

  assert.equal(stacksRequired(target.values()), 1);
  assert.equal(target.get('gray_carpet'), 64);
  assert.equal(target.get('red_carpet') || 0, 0);
});

test('restock seed clears once material exists in inventory', () => {
  const cells = emptyCells();
  cells[0][0] = 'gray_carpet';
  const bot = fakeBot();
  bot.inventory.slots[36] = item('gray_carpet', 64, 36);
  const config = fakeConfig();
  config.nerv.carpetConfig.materialChests.gray_carpet = [config.nerv.carpetConfig.reset];
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];
  printer.availableHotBarSlots = [0];
  printer.seedRestockMaterial('gray_carpet', { x: 0, y: 108, z: 0 });

  printer.getRestockTargetItems();

  assert.equal(printer.restockSeedMaterials.has('gray_carpet'), false);
});

test('no-free-slot restock preserves active restock list for dump retry', async () => {
  const bot = fakeBot();
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitRestockResponse';
  printer.restockList = [{ itemName: 'red_carpet', stacks: 1, rawAmount: 64 }];
  const playerSlots = Array.from({ length: 36 }, (_, index) => item('blue_carpet', 64, 4 + index));
  const window = {
    inventoryStart: 4,
    slots: [
      item('red_carpet', 64, 0),
      item('red_carpet', 64, 1),
      item('blue_carpet', 64, 2),
      item('blue_carpet', 64, 3),
      ...playerSlots
    ]
  };

  await printer.handleInventoryWindow(window);

  assert.equal(printer.state, 'Walking');
  assert.equal(printer.checkpoints[0].action, 'dump');
  assert.equal(printer.restockList[0].itemName, 'red_carpet');
  assert.equal(printer.restockList[0].stacks, 1);
});

test('restock audit refuses to leave short target inventory', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const bot = fakeBot();
  bot.inventory.slots[36] = item('red_carpet', 64, 36);
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 1];
  printer.availableHotBarSlots = [0, 1];
  printer.restockTargetItems = new Map([['red_carpet', 128]]);
  printer.restockList = [{ itemName: 'red_carpet', stacks: 0, rawAmount: 0 }];

  printer.endRestocking();

  assert.equal(printer.state, 'Walking');
  assert.equal(printer.restockList[0].itemName, 'red_carpet');
  assert.equal(printer.restockList[0].stacks, 1);
});

test('swapIntoHotbar uses swap action with real item slot', async () => {
  const bot = fakeBot();
  bot.inventory.slots[17] = item('red_carpet', 64, 17);
  bot.inventory.slots[36] = item('blue_carpet', 64, 36);
  const clicks = [];
  bot.clickWindow = async (slot, mouseButton, mode) => {
    clicks.push([slot, mouseButton, mode]);
    assert.equal(mode, 2);
    const target = 36 + mouseButton;
    [bot.inventory.slots[slot], bot.inventory.slots[target]] = [bot.inventory.slots[target], bot.inventory.slots[slot]];
  };
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0, 17];
  printer.availableHotBarSlots = [0];

  await printer.swapIntoHotbar(17);

  assert.deepEqual(clicks, [[17, 0, 2]]);
  assert.equal(bot.inventory.slots[36].name, 'red_carpet');
});

test('startBuilding resets dirty map area instead of repairing thousands of wrong blocks', () => {
  const cells = emptyCells();
  for (let x = 0; x < 128; x += 1) {
    for (let z = 0; z < 128; z += 1) cells[x][z] = 'red_carpet';
  }
  const bot = fakeBot();
  bot.blockAt = () => ({ name: 'blue_carpet' });
  const config = fakeConfig();
  config.printer.resetDirtyMapErrorLimit = 10;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  printer.startBuilding();

  assert.equal(printer.state, 'Walking');
  assert.deepEqual(printer.checkpoints.map((checkpoint) => checkpoint.action), ['reset']);
});

test('finish path rebuilds when planned cells are still open', async () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const bot = fakeBot();
  bot.blockAt = (pos) => {
    if (pos.x === 0 && pos.y === 108 && pos.z === 0) return { name: 'air' };
    return { name: 'stone' };
  };
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  await printer.handleFinishedPath();

  assert.equal(printer.checkpoints.length > 0, true);
  assert.notEqual(printer.checkpoints[0].action, 'dump');
});

test('reset interaction timeout falls through to area-clear wait', async () => {
  const bot = fakeBot();
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitResetResponse';
  printer.settings.retryInteractMs = 50;
  printer.settings.interactRecoveryRetries = 1;
  printer.settings.interactRecoveryCycles = 1;
  printer.settings.resetChestCloseDelayMs = 0;
  printer.lastInteractedBlockPos = { x: 1, y: 108, z: 1 };
  printer.lastInteractRecoveryCheckpoint = {
    goal: { x: 1.5, y: 108, z: 1.5 },
    action: 'reset',
    target: { x: 1, y: 108, z: 1 }
  };
  printer.interactTimeoutTicks = 1;

  await printer.tick();

  assert.equal(printer.state, 'Walking');
  assert.equal(printer.interactTimeoutTicks, 0);
  assert.equal(printer.closeResetChestTicks, 0);
  assert.equal(printer.checkpoints[0].action, 'awaitClear');
});

test('finished map timeout without filled map queues reset', async () => {
  const bot = fakeBot();
  const printer = new NervCarpetPrinter(bot, fakeConfig(), {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.state = 'AwaitFinishedMapChestResponse';
  printer.settings.interactRecoveryRetries = 1;
  printer.settings.interactRecoveryCycles = 1;
  printer.lastInteractedBlockPos = { x: 1, y: 108, z: 1 };
  printer.lastInteractRecoveryCheckpoint = {
    goal: { x: 1.5, y: 108, z: 1.5 },
    action: 'finishedMapChest',
    target: { x: 1, y: 108, z: 1 }
  };
  printer.interactTimeoutTicks = 1;

  await printer.tick();

  assert.equal(printer.state, 'Walking');
  assert.equal(printer.checkpoints.at(-1).action, 'reset');
});

test('reset view distance boosts then restores', () => {
  const bot = fakeBot();
  bot.settings = { viewDistance: 2 };
  const seen = [];
  bot.setSettings = (settings) => {
    seen.push(settings.viewDistance);
    bot.settings.viewDistance = settings.viewDistance;
  };
  const config = fakeConfig();
  config.printer.resetViewDistance = 12;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  printer.beginResetCloseWait();
  printer.restoreResetViewDistance();

  assert.deepEqual(seen, [12, 2]);
});

test('calculateBuildingPath treats pending optimistic placements as temporarily filled', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const printer = new NervCarpetPrinter(fakeBot(), fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.optimisticPlacements.set('0,108,0', { material: 'red_carpet', expiresAt: Date.now() + 10000 });

  printer.calculateBuildingPath(true, true);

  assert.deepEqual(printer.checkpoints, []);
});

test('expired optimistic placement reopens cell for retry', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  const printer = new NervCarpetPrinter(fakeBot(), fakeConfig(), {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.optimisticPlacements.set('0,108,0', { material: 'red_carpet', expiresAt: Date.now() - 1 });

  printer.calculateBuildingPath(true, true);

  assert.equal(printer.checkpoints.length > 0, true);
});

test('checkpointReached accepts a close Mineflayer pass-through without widening config', () => {
  const bot = fakeBot();
  const config = fakeConfig();
  config.printer.checkpointBuffer = 0.2;
  config.printer.minCheckpointBuffer = 0.2;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  const checkpoint = { goal: { x: 1, y: 108, z: 0 }, action: 'lineEnd' };

  bot.entity.position = new Vec3(0.6, 108, 0);
  assert.equal(printer.checkpointReached(checkpoint), false);
  bot.entity.position = new Vec3(0.72, 108, 0);
  assert.equal(printer.checkpointReached(checkpoint), false);
  bot.entity.position = new Vec3(1.35, 108, 0);
  assert.equal(printer.checkpointReached(checkpoint), true);
});

test('checkpointReached rejects print pass-throughs that are too far sideways', () => {
  const bot = fakeBot();
  const config = fakeConfig();
  config.printer.checkpointBuffer = 0.2;
  config.printer.minCheckpointBuffer = 0.2;
  config.printer.printCheckpointSideTolerance = 1.5;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  const checkpoint = { goal: { x: 10, y: 108, z: 0 }, action: 'lineEnd' };

  bot.entity.position = new Vec3(9.5, 108, 2);
  assert.equal(printer.checkpointReached(checkpoint), false);
  bot.entity.position = new Vec3(10.5, 108, 2);
  assert.equal(printer.checkpointReached(checkpoint), false);
});

test('checkpointReached keeps print lines tight but allows near interact stations', () => {
  const bot = fakeBot();
  const config = fakeConfig();
  config.printer.checkpointBuffer = 0.2;
  config.printer.minCheckpointBuffer = 0.2;
  config.printer.interactCheckpointBuffer = 0.85;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  bot.entity.position = new Vec3(0.65, 108, 0);
  assert.equal(printer.checkpointReached({ goal: { x: 0, y: 108, z: 0 }, action: '' }), false);
  assert.equal(printer.checkpointReached({ goal: { x: 0, y: 108, z: 0 }, action: 'dump' }), true);
});

test('tickWalking pathfinds for interact checkpoints only', async () => {
  const bot = fakeBot();
  const goals = [];
  bot.pathfinder = {
    movements: {},
    setGoal(goal) {
      goals.push(goal);
    }
  };
  const config = fakeConfig();
  config.printer.pathfinderForInteractTravel = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.checkpoints = [{ goal: { x: 10, y: 108, z: 0 }, action: 'refill' }];

  await printer.tickWalking(0);

  assert.equal(goals.length, 1);
});

test('steerToward pathfinds only for interact travel', () => {
  const bot = fakeBot();
  const goals = [];
  bot.pathfinder.setGoal = (goal) => goals.push(goal);
  let forward = false;
  bot.setControlState = (name, value) => {
    if (name === 'forward') forward = value;
  };
  const config = fakeConfig();
  config.printer.pathfinderForInteractTravel = true;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  printer.steerToward({ x: 10, y: 108, z: 0 }, 'refill');
  assert.equal(goals.length, 1);
  assert.equal(forward, false);

  printer.steerToward({ x: 10, y: 108, z: 0 }, '');
  assert.equal(goals.at(-1), null);
  assert.equal(forward, true);
});

test('steerToward can packet-step print rows without Mineflayer walk drag', () => {
  const bot = fakeBot();
  const writes = [];
  const controls = [];
  bot._client = {
    write(name, packet) {
      writes.push([name, packet]);
    }
  };
  bot.setControlState = (name, value) => controls.push([name, value]);
  const config = fakeConfig();
  config.printer.packetPrintMovement = true;
  config.printer.unsneakWhileWalking = false;
  config.printer.packetPrintSpeed = 5.6;
  config.printer.packetPrintMaxStep = 0.45;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  printer.steerToward({ x: 0, y: 108, z: 10 }, 'lineEnd');

  assert.equal(bot.physicsEnabled, false);
  assert.equal(bot.entity.position.z > 0.2, true);
  assert.equal(bot.entity.position.z <= 0.45, true);
  assert.deepEqual(controls, [['forward', false], ['sprint', false], ['sneak', false]]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'position_look');
});

test('steerToward cuts sprinting when food is low', () => {
  const bot = fakeBot();
  bot.food = 4;
  bot.pathfinder.movements = { allowSprinting: true };
  const config = fakeConfig();
  config.printer.pathfinderForInteractTravel = true;
  config.printer.sprintMode = 'NotPlacing';
  config.printer.sprintMinFood = 6;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  assert.equal(printer.shouldSprint('sprint'), false);
  printer.steerToward({ x: 10, y: 108, z: 0 }, 'refill');
  assert.equal(bot.pathfinder.movements.allowSprinting, false);
});

test('print candidate scans reuse cached block reads within one tick', () => {
  const cells = emptyCells();
  cells[0][0] = 'red_carpet';
  cells[0][1] = 'red_carpet';
  let reads = 0;
  const bot = fakeBot();
  bot.entity.position = new Vec3(0.5, 108, 2.5);
  bot.blockAt = (pos) => {
    reads += 1;
    if (pos.y === 108) return { name: 'air' };
    return { name: 'stone' };
  };
  const config = fakeConfig();
  config.printer.placeRange = 5;
  config.printer.minPlaceDistance = 0.1;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });

  printer.beginTickCaches();
  try {
    assert.equal(printer.scanPrintCandidates({ x: 0.5, y: 108, z: 127.5 }).length, 2);
    assert.equal(printer.scanPrintCandidates({ x: 0.5, y: 108, z: 127.5 }).length, 2);
  } finally {
    printer.endTickCaches();
  }

  assert.equal(reads, 2);
});

test('dumping converts saved Minecraft yaw/pitch before looking', async () => {
  const bot = fakeBot();
  let looked = null;
  bot.look = async (yaw, pitch) => {
    looked = { yaw, pitch };
  };
  const config = fakeConfig();
  config.nerv.carpetConfig.dumpStation.yaw = 0;
  config.nerv.carpetConfig.dumpStation.pitch = 30;
  const printer = new NervCarpetPrinter(bot, config, {
    map: { width: 128, depth: 128, cells: emptyCells() },
    mapFile: '/tmp/map.nbt',
    nervFolder: '/tmp'
  });
  printer.availableSlots = [0];

  await printer.tickDumping();

  assert.ok(Math.abs(looked.yaw - Math.PI) < 0.001);
  assert.ok(Math.abs(looked.pitch + Math.PI / 6) < 0.001);
});
