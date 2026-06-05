const fs = require('node:fs/promises');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { findNextMapFile } = require('./nerv-folder');
const { loadFlatMap } = require('./nbt-loader');

const TICK_MS = 50;
const AIR = new Set(['air', 'cave_air', 'void_air']);
const REPLACEABLE_BLOCKS = new Set(['water', 'lava']);
const MAP_ITEM = 'map';
const FILLED_MAP_ITEM = 'filled_map';
const GLASS_PANE_ITEM = 'glass_pane';
const CARTOGRAPHY_TABLE_ITEM = 'cartography_table';
const EMPTY_BUCKET_ITEM = 'bucket';
const WATER_BUCKET_ITEM = 'water_bucket';
const INTERACTABLE_SUPPORTS = new Set([
  'barrel',
  'beacon',
  'brewing_stand',
  'chest',
  'crafting_table',
  'crafter',
  'dispenser',
  'dropper',
  'enchanting_table',
  'ender_chest',
  'furnace',
  'grindstone',
  'hopper',
  'jukebox',
  'lectern',
  'loom',
  'note_block',
  'shulker_box',
  'smithing_table',
  'smoker',
  'stonecutter',
  'trapped_chest'
]);
const INTERACT_CHECKPOINT_ACTIONS = new Set([
  'awaitClear',
  'break',
  'cartographyTable',
  'dump',
  'finishedMapChest',
  'mapMaterialChest',
  'refill',
  'reset',
  'waterBucketMakeRoom',
  'waterBucketPickup',
  'waterBucketStore',
  'waterDrainBlocked'
]);
const PRINT_CHECKPOINT_ACTIONS = new Set(['', 'lineEnd', 'sprint']);
const PLACEMENT_SIDES = [
  { name: 'west', vector: new Vec3(-1, 0, 0), score: (look) => -look.x },
  { name: 'east', vector: new Vec3(1, 0, 0), score: (look) => look.x },
  { name: 'down', vector: new Vec3(0, -1, 0), score: (look) => -look.y },
  { name: 'up', vector: new Vec3(0, 1, 0), score: (look) => look.y },
  { name: 'north', vector: new Vec3(0, 0, -1), score: (look) => -look.z },
  { name: 'south', vector: new Vec3(0, 0, 1), score: (look) => look.z }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toVec3(pos) {
  return new Vec3(pos.x, pos.y, pos.z);
}

function centerOf(pos) {
  return new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5);
}

function posKey(pos) {
  return `${pos.x},${pos.y},${pos.z}`;
}

function clonePos(pos) {
  return { x: pos.x, y: pos.y, z: pos.z };
}

function distance3d(a, b) {
  const dx = b.x - a.x;
  const dy = (b.y ?? a.y) - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function distanceToCenter(botPos, pos) {
  const dx = pos.x + 0.5 - botPos.x;
  const dy = pos.y + 0.5 - botPos.y;
  const dz = pos.z + 0.5 - botPos.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function offsetPos(pos, vector) {
  return { x: pos.x + vector.x, y: pos.y + vector.y, z: pos.z + vector.z };
}

function stacksRequired(amounts) {
  return [...amounts].reduce((sum, amount) => sum + (amount > 0 ? Math.ceil(amount / 64) : 0), 0);
}

function formatMaterialCounts(map) {
  const entries = [...map.entries()].filter(([, count]) => count > 0);
  if (entries.length === 0) return 'none';
  return entries.map(([name, count]) => `${name}=${count}`).join(', ');
}

function formatMaterialStacks(map) {
  const entries = [...map.entries()].filter(([, count]) => count > 0);
  if (entries.length === 0) return 'none';
  return entries
    .map(([name, count]) => `${name}=${Math.ceil(count / 64)} stacks (${count})`)
    .join(', ');
}

function roundMaterialCountsToFullStacks(map) {
  const rounded = new Map();
  for (const [name, count] of map.entries()) {
    rounded.set(name, count > 0 ? Math.ceil(count / 64) * 64 : count);
  }
  return rounded;
}

function capMaterialCountsToStackSlots(map, slotCapacity, pinned = new Set()) {
  if (!Number.isFinite(slotCapacity) || slotCapacity <= 0) return map;
  while (stacksRequired(map.values()) > slotCapacity) {
    const removable = [...map.entries()].reverse().find((entry) => {
      const [name, count] = entry;
      return count > 0 && !pinned.has(name);
    });
    if (!removable) break;
    const [name, count] = removable;
    const next = Math.max(0, count - 64);
    map.set(name, next);
  }
  return map;
}

function ticksFromMs(ms) {
  return Math.max(0, Math.round(ms / TICK_MS));
}

function fromNotchianYawDegrees(degrees) {
  const radians = Math.PI - degrees * Math.PI / 180;
  return ((radians % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

function fromNotchianPitchDegrees(degrees) {
  const radians = -degrees * Math.PI / 180;
  return ((radians + Math.PI) % (Math.PI * 2)) - Math.PI;
}

function toNotchianYawRadians(radians) {
  return (Math.PI - radians) * 180 / Math.PI;
}

function toNotchianPitchRadians(radians) {
  return -radians * 180 / Math.PI;
}

function shuffle(values) {
  const shuffled = [...values];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function vectorToDirection(v) {
  if (v.y < 0) return 0;
  if (v.y > 0) return 1;
  if (v.z < 0) return 2;
  if (v.z > 0) return 3;
  if (v.x < 0) return 4;
  if (v.x > 0) return 5;
  throw new Error(`Invalid face vector ${v}`);
}

class NervCarpetPrinter {
  constructor(bot, config, options = {}) {
    this.bot = bot;
    this.config = config;
    this.nervFolder = options.nervFolder;
    this.startedFiles = options.mapFile ? [options.mapFile] : [];
    this.mapFile = options.mapFile || null;
    this.map = options.map || null;

    this.state = 'Idle';
    this.oldState = null;
    this.checkpoints = [];
    this.restockList = [];
    this.restockBacklogSlots = [];
    this.restockSeedMaterials = new Map();
    this.restockTargetItems = null;
    this.checkedChests = new Set();
    this.knownErrors = [];
    this.waterDrainCurrent = null;
    this.waterDrainAttempts = new Map();
    this.waterDispenserOpenFailures = new Map();
    this.waterMissingBucketSources = new Set();
    this.waterDrainMakeRoom = false;
    this.waterUseSequence = 0;
    this.unknownWaterSourceLogs = new Set();
    this.lastAntiVelocityTickLogAt = 0;
    this.restockResumeState = null;
    this.waterResumeState = null;
    this.optimisticPlacements = new Map();
    this.pendingPlacements = new Map();
    this.abandonedPlacements = new Map();
    this.lastInteractedBlockPos = null;
    this.lastInteractRecoveryCheckpoint = null;
    this.lastInteractPreferActivate = false;
    this.lastInteractPreferContainerOpen = false;
    this.lastInteractPreferTopFace = false;
    this.lastInteractPreferFaceVector = null;
    this.interactRetryCount = 0;
    this.interactRecoveryCycleCount = 0;
    this.toBeHandledWindow = null;
    this.closeNextWindow = false;
    this.closeResetChestTicks = 0;
    this.resetViewRestoreTicks = 0;
    this.savedViewDistance = null;
    this.interactTimeoutTicks = 0;
    this.timeoutTicks = 0;
    this.toBeSwappedSlot = -1;
    this.lastSwappedMaterial = null;
    this.miningPos = null;
    this.running = false;
    this.stopped = false;
    this.lastPlacementTime = Date.now();
    this.debugPreviousState = null;
    this.lastProgressLogAt = Date.now();
    this.lastAreaClearLogAt = 0;
    this.lastSealHoldLogAt = 0;
    this.sentPlacements = 0;
    this.tickId = 0;
    this.tickBlockCache = null;
    this.tickScanCache = null;
    this.lastOptimisticPruneTick = -1;
    this.lastOptimisticPruneAt = 0;
    this.lineSealCacheKey = null;
    this.lineSealOpenKeys = null;
    this.checkpointKey = null;
    this.checkpointBestDistance = Number.POSITIVE_INFINITY;
    this.checkpointAxis = null;
    this.checkpointAxisOffset = null;
    this.lastWalkingProgressAt = Date.now();
    this.lastPathfinderStallLogAt = 0;
    this.interactRecoveryUntil = 0;
    this.pathfinderGoalKey = null;
    this.lastUnsneakAt = 0;
    this.lastPacketPrintMoveAt = 0;
    this.packetPrintMovementActive = false;
    this.blockLookupVec = new Vec3(0, 0, 0);
    this.placementReferenceStats = { side: 0, below: 0, clickableBelow: 0, packetSneak: 0, controlSneak: 0 };
    this.workingInterval = { left: 0, right: 127 };
    this.availableSlots = [];
    this.availableHotBarSlots = [];

    this.carpetConfig = config.nerv.carpetConfig;
    this.settings = config.printer;
    this.materialNames = new Set(Object.keys(this.carpetConfig?.materialChests || {}));

    this.onWindowOpen = (window) => this.handleWindowOpen(window);
    this.bot.on?.('windowOpen', this.onWindowOpen);
  }

  info(message) {
    console.log(`[carpet:${this.state}] ${message}`);
  }

  warn(message) {
    console.warn(`[carpet:${this.state}] ${message}`);
  }

  isResetWaterState() {
    return [
      'AwaitAreaClear',
      'AwaitResetResponse',
      'AwaitResetSettle',
      'AwaitWaterBucketPickup',
      'AwaitWaterBucketStore',
      'WaterBucketDrain',
      'WaterBucketMakeRoom',
      'WaterBucketRecover',
      'WaterDrainBlocked'
    ].includes(this.state);
  }

  zeroVelocityForResetWater() {
    if (this.settings.antiVelocity === false || !this.isResetWaterState()) return false;
    if (!this.bot.entity?.velocity?.set) return false;
    this.bot.entity.velocity.set(0, 0, 0);
    this.anchorLiquidAntiVelocity();
    const now = Date.now();
    if (this.settings.debugPrints && now - this.lastAntiVelocityTickLogAt > 30000) {
      this.lastAntiVelocityTickLogAt = now;
      this.info('antiVelocity tick guard active');
    }
    return true;
  }

  anchorLiquidAntiVelocity() {
    if (this.settings.antiVelocityLiquid === false || !this.waterDrainCurrent?.source) return false;
    if (this.state === 'AwaitWaterBucketPickup' || this.state === 'AwaitWaterBucketStore') {
      if (Number.isInteger(this.waterDrainCurrent.openAnchorIndex)) {
        return this.snapToWaterDrainOpenGoal(this.waterDrainCurrent.source, this.waterDrainCurrent.openAnchorIndex);
      }
      return this.snapToWaterDrainPickupGoal(this.waterDrainCurrent.source);
    }
    if (this.state !== 'WaterBucketDrain') return false;
    if (this.waterDrainCurrent.pickupAnchor === 'side') {
      return this.snapToWaterDrainPickupGoal(this.waterDrainCurrent.source);
    }
    if (this.waterDrainCurrent.pickupAnchor === 'under') {
      return this.snapToWaterDrainUnder(this.waterDrainCurrent.source);
    }
    return this.snapToWaterDrainSource(this.waterDrainCurrent.source, this.waterDrainCurrent.access);
  }

  validateConfig() {
    const required = [
      ['reset', this.carpetConfig?.reset],
      ['cartographyTable', this.carpetConfig?.cartographyTable],
      ['finishedMapChest', this.carpetConfig?.finishedMapChest],
      ['dumpStation', this.carpetConfig?.dumpStation],
      ['mapCorner', this.carpetConfig?.mapCorner],
      ['mapMaterialChests', this.carpetConfig?.mapMaterialChests?.length],
      ['materialChests', Object.keys(this.carpetConfig?.materialChests || {}).length]
    ];
    const missing = required.filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`Carpet config is missing required fields: ${missing.join(', ')}`);
    }
  }

  async initialize() {
    this.validateConfig();
    if (!this.map && !await this.prepareNextMapFile()) return;
    this.startBuilding();
  }

  status() {
    return {
      state: this.state,
      mapFile: this.mapFile,
      checkpoints: this.checkpoints.length,
      restockItems: this.restockList.length,
      knownErrors: this.knownErrors.length,
      sentPlacements: this.sentPlacements
    };
  }

  logStateChange() {
    if (this.debugPreviousState === this.state) return;
    this.debugPreviousState = this.state;
    this.info(`State -> ${this.state}`);
  }

  logProgress() {
    const interval = this.settings.progressLogMs ?? 10000;
    if (interval <= 0 || Date.now() - this.lastProgressLogAt < interval) return;
    this.lastProgressLogAt = Date.now();
    const pos = this.bot.entity?.position;
    const posText = pos ? `${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}` : 'unknown';
    const checkpoint = this.checkpoints[0];
    const checkpointText = checkpoint
      ? `${checkpoint.action || 'line'}@${checkpoint.goal.x.toFixed(2)},${checkpoint.goal.z.toFixed(2)} ` +
        `d=${this.checkpointDistance(checkpoint.goal).toFixed(2)} best=${this.checkpointBestDistance.toFixed(2)}`
      : 'none';
    const pending = this.pendingSummary();
    this.info(
      `Progress pos=${posText} checkpoints=${this.checkpoints.length} ` +
      `next=${checkpointText} ` +
      `restock=${this.restockList.length} queuedStacks=${this.restockBacklogSlots.length} ` +
      `errors=${this.knownErrors.length} sent=${this.sentPlacements} ` +
      `pending=${this.pendingPlacements.size}(air=${pending.air},solid=${pending.solid},due=${pending.due}) ` +
      `optimistic=${this.optimisticPlacements.size} ` +
      `refs=${this.placementReferenceStats.side}/${this.placementReferenceStats.below}/${this.placementReferenceStats.clickableBelow} ` +
      `sneak=${this.placementReferenceStats.packetSneak}/${this.placementReferenceStats.controlSneak}`
    );
  }

  pendingSummary() {
    const now = Date.now();
    const summary = { air: 0, solid: 0, due: 0 };
    for (const entry of this.pendingPlacements.values()) {
      const block = this.blockAt(entry.pos);
      if (block && AIR.has(block.name)) summary.air += 1;
      else if (block) summary.solid += 1;
      if (entry.nextRetryAt <= now) summary.due += 1;
    }
    return summary;
  }

  stop() {
    this.stopped = true;
    this.running = false;
    this.stopMovement();
    this.bot.removeListener?.('windowOpen', this.onWindowOpen);
  }

  pause() {
    if (this.state !== 'Paused') {
      this.oldState = this.state;
      this.state = 'Paused';
      this.stopMovement();
    }
  }

  resume() {
    if (this.state === 'Paused') {
      this.state = this.oldState || 'Walking';
      this.oldState = null;
    }
  }

  isConnected() {
    return Boolean(this.bot.player && this.bot._client?.socket && !this.bot._client.socket.destroyed);
  }

  async prepareNextMapFile() {
    const nextMap = this.mapFile || await findNextMapFile(
      this.nervFolder,
      this.startedFiles,
      this.settings.moveToFinishedFolder
    );
    if (!nextMap) {
      if (this.settings.disableOnFinished) {
        this.info('All NBT files finished.');
        this.stop();
      }
      return false;
    }
    this.mapFile = nextMap;
    if (!this.startedFiles.includes(nextMap)) this.startedFiles.push(nextMap);
    this.map = await loadFlatMap(nextMap);
    this.info(`Building ${path.basename(nextMap)}`);
    for (const entry of this.map.requirements || []) {
      this.info(`Requirement ${entry.name}: ${entry.count}`);
    }
    return true;
  }

  async moveFinishedMapFile() {
    if (!this.settings.moveToFinishedFolder || !this.mapFile) return;
    const finishedFolder = path.join(path.dirname(this.mapFile), '_finished_maps');
    await fs.mkdir(finishedFolder, { recursive: true });
    const destination = path.join(finishedFolder, path.basename(this.mapFile));
    try {
      await fs.rename(this.mapFile, destination);
      this.info(`Moved ${path.basename(this.mapFile)} to _finished_maps.`);
    } catch (error) {
      this.warn(`Failed to move ${path.basename(this.mapFile)}: ${error.message}`);
    }
  }

  mapCorner() {
    return this.carpetConfig.mapCorner;
  }

  absolutePos(x, z) {
    const corner = this.mapCorner();
    return { x: corner.x + x, y: corner.y, z: corner.z + z };
  }

  relativePos(pos) {
    const corner = this.mapCorner();
    return { x: pos.x - corner.x, y: pos.y - corner.y, z: pos.z - corner.z };
  }

  blockAt(pos) {
    if (!this.bot.blockAt) return undefined;
    this.blockLookupVec.x = pos.x;
    this.blockLookupVec.y = pos.y;
    this.blockLookupVec.z = pos.z;
    return this.bot.blockAt(this.blockLookupVec);
  }

  beginTickCaches() {
    this.tickId += 1;
    this.tickBlockCache = new Map();
    this.tickScanCache = new Map();
  }

  endTickCaches() {
    this.tickBlockCache = null;
    this.tickScanCache = null;
  }

  clearPrintCaches() {
    this.tickScanCache?.clear();
    this.lineSealCacheKey = null;
    this.lineSealOpenKeys = null;
  }

  cloneCheckpoint(checkpoint) {
    if (!checkpoint) return checkpoint;
    return {
      ...checkpoint,
      goal: checkpoint.goal ? clonePos(checkpoint.goal) : checkpoint.goal,
      target: checkpoint.target ? clonePos(checkpoint.target) : checkpoint.target,
      dispenser: checkpoint.dispenser ? clonePos(checkpoint.dispenser) : checkpoint.dispenser,
      referencePos: checkpoint.referencePos ? clonePos(checkpoint.referencePos) : checkpoint.referencePos
    };
  }

  cloneCheckpointQueue(checkpoints = []) {
    return checkpoints.map((checkpoint) => this.cloneCheckpoint(checkpoint));
  }

  captureWaterResumeState(reason = 'water') {
    if (this.waterResumeState) return false;
    const hasPrintPath = this.checkpoints.some((checkpoint) => this.isPrintCheckpointAction(checkpoint.action));
    if (!hasPrintPath) return false;
    this.waterResumeState = {
      reason,
      state: this.state,
      checkpoints: this.cloneCheckpointQueue(this.checkpoints),
      checkpointKey: this.checkpointKey,
      checkpointBestDistance: this.checkpointBestDistance,
      checkpointAxis: this.checkpointAxis,
      checkpointAxisOffset: this.checkpointAxisOffset,
      lastWalkingProgressAt: this.lastWalkingProgressAt
    };
    this.info(
      `Saved print resume state before ${reason} (${this.waterResumeState.checkpoints.length} checkpoints).`
    );
    return true;
  }

  restoreWaterResumeStateIfClear(reason = 'water cleanup') {
    const snapshot = this.waterResumeState;
    if (!snapshot) return false;
    if (this.findDrainableWaterSources(1).length > 0) return false;
    this.waterResumeState = null;
    this.waterDrainCurrent = null;
    this.checkpoints = this.cloneCheckpointQueue(snapshot.checkpoints);
    this.checkpointKey = null;
    this.checkpointBestDistance = Number.POSITIVE_INFINITY;
    this.checkpointAxis = null;
    this.checkpointAxisOffset = null;
    this.lastWalkingProgressAt = Date.now();
    this.timeoutTicks = ticksFromMs(this.settings.waterDrainActionDelayMs ?? 500);
    this.state = this.checkpoints.length > 0 ? 'Walking' : (snapshot.state || 'Idle');
    this.info(
      `Water cleanup complete; resuming ${snapshot.state || 'Walking'} ` +
      `(${snapshot.checkpoints.length} checkpoints, reason=${reason}).`
    );
    return true;
  }

  restoreWaterResumeStateIgnoringSkipped(reason = 'skipped water cleanup') {
    const snapshot = this.waterResumeState;
    if (!snapshot) return false;
    this.waterResumeState = null;
    this.waterDrainCurrent = null;
    this.checkpoints = this.cloneCheckpointQueue(snapshot.checkpoints);
    this.checkpointKey = null;
    this.checkpointBestDistance = Number.POSITIVE_INFINITY;
    this.checkpointAxis = null;
    this.checkpointAxisOffset = null;
    this.lastWalkingProgressAt = Date.now();
    this.timeoutTicks = ticksFromMs(this.settings.waterDrainActionDelayMs ?? 500);
    this.state = this.checkpoints.length > 0 ? 'Walking' : (snapshot.state || 'Idle');
    this.info(
      `Water cleanup skipped blocked source(s); resuming ${snapshot.state || 'Walking'} ` +
      `(${snapshot.checkpoints.length} checkpoints, reason=${reason}).`
    );
    return true;
  }

  blockAtCached(pos) {
    if (!this.tickBlockCache) return this.blockAt(pos);
    const key = posKey(pos);
    if (!this.tickBlockCache.has(key)) {
      this.tickBlockCache.set(key, this.blockAt(pos));
    }
    return this.tickBlockCache.get(key);
  }

  isAirAt(pos) {
    const block = this.blockAt(pos);
    return Boolean(block && AIR.has(block.name));
  }

  isOpenBlock(block) {
    return Boolean(block && (AIR.has(block.name) || REPLACEABLE_BLOCKS.has(block.name)));
  }

  isOpenAt(pos) {
    return this.isOpenBlock(this.blockAt(pos));
  }

  isOpenAtCached(pos) {
    return this.isOpenBlock(this.blockAtCached(pos));
  }

  isAirForPlacement(pos) {
    this.pruneOptimisticPlacements();
    return this.isOpenAt(pos) && !this.optimisticPlacements.has(posKey(pos)) && !this.isAbandonedPlacement(pos);
  }

  isOpenForPlanning(pos) {
    this.pruneOptimisticPlacements();
    return this.isOpenAt(pos) && !this.optimisticPlacements.has(posKey(pos)) && !this.isAbandonedPlacement(pos);
  }

  isOpenForRestockPlanning(pos) {
    return this.isOpenAt(pos);
  }

  hasMaterialAt(pos, material) {
    const block = this.blockAt(pos);
    return Boolean(block && block.name === material);
  }

  isClickableReference(block) {
    if (!block) return false;
    return this.shouldSneakForReference(block);
  }

  placementLookVector(pos) {
    const eyeHeight = this.bot.entity?.height || this.bot.entity?.eyeHeight || 1.62;
    const eye = (this.bot.entity?.position || new Vec3(0, 0, 0)).offset(0, eyeHeight, 0);
    return centerOf(pos).minus(eye);
  }

  getPlacementReference(pos) {
    const useAddonSideSearch = this.settings.fastPlacementReferences !== false;
    if (useAddonSideSearch) {
      const look = this.placementLookVector(pos);
      const candidates = [];
      for (const side of PLACEMENT_SIDES) {
        const neighborPos = offsetPos(pos, side.vector);
        const reference = this.blockAt(neighborPos);
        if (!reference || this.isOpenBlock(reference)) continue;
        if (this.isClickableReference(reference)) continue;
        candidates.push({
          reference,
          referencePos: neighborPos,
          faceVector: side.vector.scaled(-1),
          mode: 'side',
          clickable: false,
          score: side.score(look)
        });
      }
      candidates.sort((a, b) => b.score - a.score);
      if (candidates.length > 0) return candidates[0];
    }

    const below = this.blockAt({ x: pos.x, y: pos.y - 1, z: pos.z });
    if (!below || this.isOpenBlock(below)) return null;
    return {
      reference: below,
      referencePos: { x: pos.x, y: pos.y - 1, z: pos.z },
      faceVector: new Vec3(0, 1, 0),
      mode: 'below',
      clickable: this.shouldSneakForReference(below),
      score: Number.NEGATIVE_INFINITY
    };
  }

  isWithinMap(pos) {
    const rel = this.relativePos(pos);
    return rel.x >= 0 && rel.x < this.map.width && rel.z >= 0 && rel.z < this.map.depth;
  }

  javaSlotToWindowSlot(slot) {
    if (slot < 9) return (this.bot.QUICK_BAR_START ?? 36) + slot;
    return slot;
  }

  javaSlotToContainerWindowSlot(slot, window) {
    const inventoryStart = window?.inventoryStart ?? Math.max(0, (window?.slots?.length || 36) - 36);
    const playerIndex = slot < 9 ? 27 + slot : slot - 9;
    return inventoryStart + playerIndex;
  }

  stackInJavaSlot(slot) {
    return this.bot.inventory?.slots?.[this.javaSlotToWindowSlot(slot)] || null;
  }

  inventoryItems(name) {
    return (this.bot.inventory?.items?.() || []).filter((item) => item.name === name);
  }

  isEmptyBucketStack(stack) {
    if (!stack) return false;
    const name = String(stack.name || '');
    const display = String(stack.displayName || stack.customName || '');
    return name === EMPTY_BUCKET_ITEM || name.endsWith(':bucket') || display === 'Bucket';
  }

  isWaterBucketStack(stack) {
    if (!stack) return false;
    const name = String(stack.name || '');
    const display = String(stack.displayName || stack.customName || '');
    return name === WATER_BUCKET_ITEM || name.endsWith(':water_bucket') || display === 'Water Bucket';
  }

  isCarpetStack(stack) {
    const name = String(stack?.name || '');
    return name.endsWith('_carpet') || name === 'carpet';
  }

  inventoryBucket(empty = true) {
    const test = empty ? this.isEmptyBucketStack.bind(this) : this.isWaterBucketStack.bind(this);
    for (const stack of this.bot.inventory?.items?.() || []) {
      if (test(stack)) return stack;
    }
    for (const stack of this.bot.inventory?.slots || []) {
      if (test(stack)) return stack;
    }
    return null;
  }

  inventoryItem(name) {
    for (const stack of this.bot.inventory?.items?.() || []) {
      if (stack?.name === name) return stack;
    }
    for (const stack of this.bot.inventory?.slots || []) {
      if (stack?.name === name) return stack;
    }
    return null;
  }

  javaSlotForItem(name) {
    for (const slot of this.playerInventorySlots()) {
      const stack = this.stackInJavaSlot(slot);
      if (stack?.name === name) return slot;
    }
    return -1;
  }

  inventoryItemCount(name) {
    let total = 0;
    const slots = this.availableSlots.length > 0 ? this.availableSlots : [...Array(36).keys()];
    for (const slot of slots) {
      const stack = this.stackInJavaSlot(slot);
      if (stack?.name === name) total += stack.count;
    }
    return total;
  }

  playerInventorySlots() {
    return this.availableSlots.length > 0 ? this.availableSlots : [...Array(36).keys()];
  }

  hasFreePlayerInventorySlot() {
    return this.playerInventorySlots().some((slot) => !this.stackInJavaSlot(slot));
  }

  randomCarpetStack() {
    const stacks = [];
    for (const slot of this.playerInventorySlots()) {
      const stack = this.stackInJavaSlot(slot);
      if (stack && this.materialNames.has(stack.name)) stacks.push(stack);
    }
    if (stacks.length === 0) return null;
    return stacks[Math.floor(Math.random() * stacks.length)];
  }

  itemDefinition(name) {
    const item = this.bot.registry?.itemsByName?.[name];
    if (!item) throw new Error(`Minecraft item not known to registry: ${name}`);
    return item;
  }

  setupSlots() {
    this.availableSlots = [];
    this.availableHotBarSlots = [];
    const slotMode = this.settings.restockSlotMode || 'full';
    if (slotMode === 'full') {
      for (let slot = 0; slot < 36; slot += 1) {
        this.availableSlots.push(slot);
        if (slot < 9) this.availableHotBarSlots.push(slot);
      }
    } else {
      for (let slot = 0; slot < 36; slot += 1) {
        const stack = this.stackInJavaSlot(slot);
        if (!stack || this.materialNames.has(stack.name)) {
          this.availableSlots.push(slot);
          if (slot < 9) this.availableHotBarSlots.push(slot);
        }
      }
    }
    this.info(`Inventory slots available for building: ${this.availableSlots.join(',')} (${slotMode} mode)`);
    if (this.availableHotBarSlots.length === 0) {
      throw new Error('No free/material slots found in hotbar.');
    }
    if (this.availableSlots.length < 2) {
      throw new Error('Need at least two free/material inventory slots for carpet printing.');
    }
  }

  getRequiredItems(slotCapacityOverride = null, options = {}) {
    const required = new Map();
    let isStartSide = true;
    let hasFoundAir = false;
    const slotCapacity = slotCapacityOverride ?? (this.availableSlots.length || this.availableSlotCount || 0);
    const isOpenForPlan = options.ignoreOptimistic
      ? (pos) => this.isOpenForRestockPlanning(pos)
      : (pos) => this.isOpenForPlanning(pos);
    for (let x = this.workingInterval.left; x <= this.workingInterval.right; x += this.settings.linesPerRun) {
      for (let zStep = 0; zStep < this.map.depth; zStep += 1) {
        for (let lineBonus = 0; lineBonus < this.settings.linesPerRun; lineBonus += 1) {
          const adjustedX = x + lineBonus;
          if (adjustedX > this.workingInterval.right) break;
          let adjustedZ = isStartSide ? zStep : this.map.depth - 1 - zStep;
          const material = this.map.cells[adjustedX]?.[adjustedZ];
          if (!material) continue;
          const pos = this.absolutePos(adjustedX, adjustedZ);
          if (!isOpenForPlan(pos)) continue;
          if (!hasFoundAir) {
            hasFoundAir = true;
            const oppositeZ = this.map.depth - 1 - adjustedZ;
            const oppositePos = this.absolutePos(adjustedX, oppositeZ);
            if (!isOpenForPlan(oppositePos) && zStep < this.map.depth / 2) {
              isStartSide = !isStartSide;
              adjustedZ = isStartSide ? zStep : this.map.depth - 1 - zStep;
            }
          }
          const finalMaterial = this.map.cells[adjustedX]?.[adjustedZ];
          const finalPos = this.absolutePos(adjustedX, adjustedZ);
          if (!finalMaterial || !isOpenForPlan(finalPos)) continue;
          required.set(finalMaterial, (required.get(finalMaterial) || 0) + 1);
          if (stacksRequired(required.values()) > slotCapacity) {
            required.set(finalMaterial, required.get(finalMaterial) - 1);
            return required;
          }
        }
      }
      isStartSide = !isStartSide;
    }
    return required;
  }

  getRemainingMaterialCounts(options = {}) {
    const counts = new Map();
    const isOpenForPlan = options.ignoreOptimistic
      ? (pos) => this.isOpenForRestockPlanning(pos)
      : (pos) => this.isOpenForPlanning(pos);
    for (let x = this.workingInterval.left; x <= this.workingInterval.right; x += 1) {
      for (let z = 0; z < this.map.depth; z += 1) {
        const material = this.map.cells[x]?.[z];
        if (!material) continue;
        const pos = this.absolutePos(x, z);
        if (!isOpenForPlan(pos)) continue;
        counts.set(material, (counts.get(material) || 0) + 1);
      }
    }
    return counts;
  }

  getMapMaterialCounts() {
    const counts = new Map();
    for (let x = 0; x < this.map.width; x += 1) {
      for (let z = 0; z < this.map.depth; z += 1) {
        const material = this.map.cells[x]?.[z];
        if (!material) continue;
        counts.set(material, (counts.get(material) || 0) + 1);
      }
    }
    return counts;
  }

  pruneRestockSeedMaterials() {
    for (const [itemName] of this.restockSeedMaterials.entries()) {
      if (this.inventoryItemCount(itemName) > 0) this.restockSeedMaterials.delete(itemName);
    }
  }

  seedRestockMaterial(itemName, pos) {
    this.captureRestockResumeState(`missing ${itemName}`);
    const existing = this.restockSeedMaterials.get(itemName);
    const count = Math.max(existing?.count || 0, 64);
    this.restockSeedMaterials.set(itemName, { count, pos: clonePos(pos) });
    this.clearRestockTarget();
    this.info(`Restock seed: ${itemName} at ${posKey(pos)}`);
  }

  captureRestockResumeState(reason = 'restock') {
    if (this.restockResumeState) return false;
    const hasPrintPath = this.checkpoints.some((checkpoint) => this.isPrintCheckpointAction(checkpoint.action));
    if (!hasPrintPath) return false;
    this.restockResumeState = {
      reason,
      checkpoints: this.cloneCheckpointQueue(this.checkpoints),
      checkpointKey: this.checkpointKey,
      checkpointBestDistance: this.checkpointBestDistance,
      checkpointAxis: this.checkpointAxis,
      checkpointAxisOffset: this.checkpointAxisOffset,
      lastWalkingProgressAt: this.lastWalkingProgressAt
    };
    this.info(
      `Saved print resume state before ${reason} (${this.restockResumeState.checkpoints.length} checkpoints).`
    );
    return true;
  }

  fillRestockTargetSpareSlots(required, slotCapacity, pinned, options = {}) {
    if (!Number.isFinite(slotCapacity) || slotCapacity <= 0) return required;

    const addStack = (itemName) => {
      if (stacksRequired(required.values()) >= slotCapacity) return false;
      required.set(itemName, (required.get(itemName) || 0) + 64);
      return true;
    };

    for (const slot of this.availableSlots) {
      const stack = this.stackInJavaSlot(slot);
      if (!stack || !this.materialNames.has(stack.name)) continue;
      const desired = Math.ceil(stack.count / 64) * 64;
      while ((required.get(stack.name) || 0) < desired) {
        if (!addStack(stack.name)) return required;
      }
    }

    const desiredCounts = this.getRemainingMaterialCounts(options);
    for (const [itemName, count] of this.getMapMaterialCounts().entries()) {
      if (!desiredCounts.has(itemName)) desiredCounts.set(itemName, Math.min(count, 64));
    }

    const hasRoom = () => stacksRequired(required.values()) < slotCapacity;
    while (hasRoom()) {
      const candidates = [...desiredCounts.entries()]
        .filter(([itemName, count]) => {
          const current = required.get(itemName) || 0;
          const desired = Math.max(
            required.has(itemName) ? current + 64 : 64,
            Math.ceil(count / 64) * 64
          );
          return desired > current;
        })
        .sort((a, b) => {
          const aPinned = pinned.has(a[0]) ? 0 : 1;
          const bPinned = pinned.has(b[0]) ? 0 : 1;
          if (aPinned !== bPinned) return aPinned - bPinned;
          const aHas = required.has(a[0]) ? 1 : 0;
          const bHas = required.has(b[0]) ? 1 : 0;
          if (aHas !== bHas) return aHas - bHas;
          const aNeedsSafety = required.has(a[0]) && (required.get(a[0]) || 0) < 128 ? 0 : 1;
          const bNeedsSafety = required.has(b[0]) && (required.get(b[0]) || 0) < 128 ? 0 : 1;
          if (aNeedsSafety !== bNeedsSafety) return aNeedsSafety - bNeedsSafety;
          if (a[1] !== b[1]) return b[1] - a[1];
          const aStacks = Math.ceil((required.get(a[0]) || 0) / 64);
          const bStacks = Math.ceil((required.get(b[0]) || 0) / 64);
          return aStacks - bStacks;
        });
      if (candidates.length === 0) break;
      if (!addStack(candidates[0][0])) break;
    }

    return capMaterialCountsToStackSlots(required, slotCapacity, pinned);
  }

  getRestockTargetItems(options = {}) {
    this.pruneRestockSeedMaterials();
    const required = roundMaterialCountsToFullStacks(this.getRequiredItems(null, options));
    const seeded = new Set();
    for (const [itemName, seed] of this.restockSeedMaterials.entries()) {
      seeded.add(itemName);
      required.set(itemName, Math.max(required.get(itemName) || 0, seed.count));
    }
    const slotCapacity = this.availableSlots.length || this.availableSlotCount || 0;
    capMaterialCountsToStackSlots(required, slotCapacity, seeded);
    if ((this.settings.restockSlotMode || 'full') !== 'full') return required;
    return this.fillRestockTargetSpareSlots(required, slotCapacity, seeded, options);
  }

  getActiveRestockTargetItems() {
    if (!this.restockTargetItems) {
      this.restockTargetItems = this.getRestockTargetItems({ ignoreOptimistic: true });
    }
    return new Map(this.restockTargetItems);
  }

  clearRestockTarget() {
    this.restockTargetItems = null;
  }

  getTargetShortfall(requiredItems, slots = this.availableSlots) {
    const counts = new Map();
    const wrongSlots = [];
    for (const slot of slots) {
      const stack = this.stackInJavaSlot(slot);
      if (!stack) continue;
      if (!this.materialNames.has(stack.name) || !requiredItems.has(stack.name)) {
        wrongSlots.push(slot);
        continue;
      }
      counts.set(stack.name, (counts.get(stack.name) || 0) + stack.count);
    }

    const shortfall = new Map();
    for (const [itemName, count] of requiredItems.entries()) {
      const missing = count - (counts.get(itemName) || 0);
      if (missing > 0) shortfall.set(itemName, Math.ceil(missing / 64) * 64);
    }
    return { counts, shortfall, wrongSlots };
  }

  getInventoryMaterialInfo(requiredItems, slots = this.availableSlots) {
    const required = new Map(requiredItems);
    const dumpSlots = [];
    const counts = new Map();
    for (const slot of slots) {
      const stack = this.stackInJavaSlot(slot);
      if (!stack) continue;
      const requiredAmount = required.get(stack.name);
      if (requiredAmount !== undefined) {
        let requiredModulusAmount = requiredAmount % 64;
        if (requiredModulusAmount === 0) requiredModulusAmount = 64;
        if (requiredAmount > 0 && requiredModulusAmount <= stack.count) {
          required.set(stack.name, Math.max(0, requiredAmount - stack.count));
          counts.set(stack.name, (counts.get(stack.name) || 0) + stack.count);
          continue;
        }
      }
      dumpSlots.push(slot);
    }
    return { dumpSlots, counts };
  }

  getDumpSlot() {
    const required = this.getActiveRestockTargetItems();
    const { dumpSlots } = this.getInventoryMaterialInfo(required);
    return dumpSlots.length > 0 ? dumpSlots[0] : -1;
  }

  getDumpStack() {
    const slot = this.getDumpSlot();
    if (slot === -1) return null;
    const stack = this.stackInJavaSlot(slot);
    return stack ? { slot, stack } : null;
  }

  refillInventory(invMaterial) {
    this.captureRestockResumeState('restock refill');
    this.restockList = [];
    const required = this.getActiveRestockTargetItems();
    this.info(`Restock target: ${formatMaterialStacks(required)}`);
    if (this.restockSeedMaterials.size > 0) {
      this.info(`Restock seeded: ${[...this.restockSeedMaterials.keys()].join(', ')}`);
    }
    this.info(`Restock kept: ${formatMaterialCounts(invMaterial)}`);
    for (const [itemName, count] of invMaterial.entries()) {
      required.set(itemName, (required.get(itemName) || 0) - count);
    }
    for (const [itemName, amount] of required.entries()) {
      if (amount <= 0) continue;
      const stacks = Math.ceil(amount / 64);
      this.info(`Restocking ${stacks} stacks ${itemName} (${amount})`);
      this.restockList.unshift({ itemName, stacks, rawAmount: amount });
    }
    if (this.restockList.length === 0) this.info('Restock list empty; inventory already covers target window.');
    this.addClosestRestockCheckpoint();
  }

  distanceTo(pos) {
    const botPos = this.bot.entity?.position || new Vec3(0, 0, 0);
    return distance3d(botPos, pos);
  }

  getBestChest(itemName) {
    const list = itemName === CARTOGRAPHY_TABLE_ITEM
      ? this.carpetConfig.mapMaterialChests
      : this.carpetConfig.materialChests[itemName];
    if (!list?.length) {
      throw new Error(`No chest found for ${itemName}`);
    }

    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const entry of list) {
      if (this.checkedChests.has(posKey(entry.blockPos))) continue;
      const distance = this.distanceTo(entry.openPos);
      if (distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
    }
    if (!best) {
      this.checkedChests.clear();
      return this.getBestChest(itemName);
    }
    return best;
  }

  addClosestRestockCheckpoint() {
    if (this.restockList.length === 0) return;
    let closestEntry = null;
    let closestChest = null;
    let smallestDistance = Number.POSITIVE_INFINITY;
    for (const entry of this.restockList) {
      const chest = this.getBestChest(entry.itemName);
      const distance = this.distanceTo(chest.openPos);
      if (distance < smallestDistance) {
        closestEntry = entry;
        closestChest = chest;
        smallestDistance = distance;
      }
    }
    this.restockList = this.restockList.filter((entry) => entry !== closestEntry);
    this.restockList.unshift(closestEntry);
    this.info(
      `Restock route: ${closestEntry.itemName} -> ${posKey(closestChest.blockPos)} ` +
      `(${closestEntry.stacks} stacks left)`
    );
    this.checkpoints.unshift({ goal: closestChest.openPos, action: 'refill', target: closestChest.blockPos });
  }

  endRestocking() {
    const current = this.restockList[0];
    if (!current) {
      this.state = 'Walking';
      return;
    }
    if (current.stacks > 0) {
      this.warn('Not all necessary stacks restocked. Searching for another chest...');
      if (this.lastInteractedBlockPos) this.checkedChests.add(posKey(this.lastInteractedBlockPos));
      const next = this.getBestChest(current.itemName);
      this.checkpoints.unshift({ goal: next.openPos, action: 'refill', target: next.blockPos });
    } else {
      this.checkedChests.clear();
      this.restockSeedMaterials.delete(current.itemName);
      this.restockList.shift();
      this.addClosestRestockCheckpoint();
      if (this.restockList.length === 0) {
        const target = this.getActiveRestockTargetItems();
        const audit = this.getTargetShortfall(target);
        if (audit.wrongSlots.length > 0 || audit.shortfall.size > 0) {
          if (audit.wrongSlots.length > 0) {
            this.warn(`Restock audit found dumpable slots after refill: ${audit.wrongSlots.join(',')}`);
            this.checkpoints.unshift({ goal: this.carpetConfig.dumpStation.pos, action: 'dump' });
          } else {
            this.warn(`Restock audit shortfall: ${formatMaterialStacks(audit.shortfall)}`);
            for (const [itemName, amount] of audit.shortfall.entries()) {
              this.restockList.unshift({ itemName, stacks: Math.ceil(amount / 64), rawAmount: amount });
            }
            this.addClosestRestockCheckpoint();
          }
          this.timeoutTicks = ticksFromMs(this.settings.postRestockDelayMs);
          this.state = 'Walking';
          return;
        }
        this.clearRestockTarget();
        this.clearOpenOptimisticPlacements();
        if (this.restorePrintPathAfterRestock()) {
          this.timeoutTicks = ticksFromMs(this.settings.postRestockDelayMs);
          this.state = 'Walking';
          return;
        }
      }
    }
    this.timeoutTicks = ticksFromMs(this.settings.postRestockDelayMs);
    this.state = 'Walking';
  }

  restorePrintPathAfterRestock() {
    const oldCount = this.checkpoints.length;
    this.optimisticPlacements.clear();
    this.pendingPlacements.clear();
    this.abandonedPlacements.clear();
    this.clearPrintCaches();
    this.pathfinderGoalKey = null;
    this.interactRecoveryUntil = 0;
    this.checkpointKey = null;
    this.checkpointBestDistance = Number.POSITIVE_INFINITY;
    this.checkpointAxis = null;
    this.checkpointAxisOffset = null;
    const snapshot = this.restockResumeState;
    if (!snapshot) {
      this.warn(`No saved print resume state after restock; keeping current queue (${oldCount} checkpoints).`);
      return false;
    }
    this.checkpoints = this.cloneCheckpointQueue(snapshot.checkpoints);
    this.lastWalkingProgressAt = Date.now();
    this.restockResumeState = null;
    this.info(
      `Post-restock restored saved print path ` +
      `(reason=${snapshot.reason}, oldCheckpoints=${oldCount}, restored=${this.checkpoints.length}).`
    );
    return this.checkpoints.length > 0;
  }

  restockResumeCheckpoint(pos) {
    const current = this.checkpoints[0];
    if (!current || !this.isPrintCheckpointAction(current.action)) {
      return { goal: clonePos(pos), action: 'sprint' };
    }

    const { axis, direction } = this.printAxisAndDirection(current.goal);
    const backtrack = Math.max(1, Math.min(3, this.settings.sealMaxBacktrackBlocks ?? 3));
    const goal = clonePos(pos);
    goal.y = this.mapCorner().y;
    goal[axis] -= direction * backtrack;
    return { goal, action: 'sprint' };
  }

  calculateBuildingPath(cornerSide, sprintFirst) {
    this.clearPrintCaches();
    let isStartSide = cornerSide;
    this.checkpoints = [];
    for (let x = this.workingInterval.left; x <= this.workingInterval.right; x += this.settings.linesPerRun) {
      let lineFinished = true;
      for (let lineBonus = 0; lineBonus < this.settings.linesPerRun; lineBonus += 1) {
        const adjustedX = x + lineBonus;
        if (adjustedX > this.workingInterval.right) break;
        for (let z = 0; z < this.map.depth; z += 1) {
          const material = this.map.cells[adjustedX]?.[z];
          if (material && this.isOpenForPlanning(this.absolutePos(adjustedX, z))) {
            lineFinished = false;
            break;
          }
        }
        if (!lineFinished) break;
      }
      if (lineFinished) continue;

      const cp1 = {
        x: this.mapCorner().x + x + 0.5,
        y: this.mapCorner().y + 0.5,
        z: this.mapCorner().z + 0.5
      };
      const cp2 = {
        x: this.mapCorner().x + x + 0.5,
        y: this.mapCorner().y + 0.5,
        z: this.mapCorner().z + this.map.depth - 0.5
      };
      if (isStartSide) {
        this.checkpoints.push({ goal: cp1, action: '' });
        this.checkpoints.push({ goal: cp2, action: 'lineEnd' });
      } else {
        this.checkpoints.push({ goal: cp2, action: '' });
        this.checkpoints.push({ goal: cp1, action: 'lineEnd' });
      }
      isStartSide = !isStartSide;
    }
    if (this.checkpoints.length > 0 && sprintFirst) {
      this.checkpoints[0] = { ...this.checkpoints[0], action: 'sprint' };
    }
  }

  startBuilding() {
    if (this.availableSlots.length === 0) this.setupSlots();
    this.clearRestockTarget();
    this.restockResumeState = null;
    this.optimisticPlacements.clear();
    this.pendingPlacements.clear();
    this.abandonedPlacements.clear();
    this.clearPrintCaches();
    if (this.settings.forceResetOnStart) {
      this.warn('Force reset requested before build.');
      this.startedFiles = this.startedFiles.filter((file) => file !== this.mapFile);
      this.queueResetAfterFinishedMap();
      this.state = 'Walking';
      return;
    }
    const dirtyLimit = this.settings.resetDirtyMapErrorLimit ?? 256;
    if (dirtyLimit > 0) {
      const dirtyCount = this.countInvalidPlacements(dirtyLimit + 1);
      if (dirtyCount > dirtyLimit) {
        this.warn(`Map area has ${dirtyCount}+ wrong existing carpets; resetting before build.`);
        this.startedFiles = this.startedFiles.filter((file) => file !== this.mapFile);
        this.checkpoints = [];
        if (this.settings.breakCarpetAboveReset) {
          const above = {
            x: this.carpetConfig.reset.blockPos.x,
            y: this.carpetConfig.reset.blockPos.y + 1,
            z: this.carpetConfig.reset.blockPos.z
          };
          if (this.blockAt(above)?.name?.includes('carpet')) {
            this.checkpoints.push({ goal: this.carpetConfig.reset.openPos, action: 'break', target: above });
          }
        }
        this.checkpoints.push({ goal: this.carpetConfig.reset.openPos, action: 'reset', target: this.carpetConfig.reset.blockPos });
        this.state = 'Walking';
        return;
      }
    }
    this.calculateBuildingPath(this.settings.northToSouth, true);
    this.checkpoints.unshift({ goal: this.carpetConfig.dumpStation.pos, action: 'dump' });
    this.state = 'Walking';
  }

  async endBuilding() {
    this.info('Finished building map');
    this.state = 'Walking';
    this.knownErrors = [];
    const bestChest = this.getBestChest(CARTOGRAPHY_TABLE_ITEM);
    this.checkpoints.push({ goal: this.carpetConfig.dumpStation.pos, action: 'dump' });
    this.checkpoints.push({ goal: bestChest.openPos, action: 'mapMaterialChest' });
    await this.moveFinishedMapFile();
    return true;
  }

  getOpenPlannedCells(limit = Number.POSITIVE_INFINITY) {
    const open = [];
    for (let x = this.workingInterval.left; x <= this.workingInterval.right; x += 1) {
      for (let z = 0; z < this.map.depth; z += 1) {
        const material = this.map.cells[x]?.[z];
        if (!material) continue;
        const pos = this.absolutePos(x, z);
        const block = this.blockAt(pos);
        if (block?.name === material) continue;
        if (this.isOpenBlock(block)) {
          open.push(pos);
          if (open.length >= limit) return open;
        }
      }
    }
    return open;
  }

  restartOpenCellsFromWorld() {
    this.optimisticPlacements.clear();
    this.pendingPlacements.clear();
    this.abandonedPlacements.clear();
    this.clearPrintCaches();
    this.calculateBuildingPath(this.settings.northToSouth, true);
    return this.checkpoints.length > 0;
  }

  getInvalidPlacements() {
    const known = new Set(this.knownErrors.map(posKey));
    const invalid = [];
    for (let x = this.workingInterval.right; x >= this.workingInterval.left; x -= 1) {
      for (let z = this.map.depth - 1; z >= 0; z -= 1) {
        const pos = this.absolutePos(x, z);
        if (known.has(posKey(pos))) continue;
        const block = this.blockAt(pos);
        if (!block || this.isOpenBlock(block)) continue;
        const expected = this.map.cells[x]?.[z] || null;
        if (block.name !== expected) invalid.push(pos);
      }
    }
    return invalid;
  }

  countInvalidPlacements(limit = Number.POSITIVE_INFINITY) {
    let count = 0;
    for (let x = this.workingInterval.right; x >= this.workingInterval.left; x -= 1) {
      for (let z = this.map.depth - 1; z >= 0; z -= 1) {
        const block = this.blockAt(this.absolutePos(x, z));
        if (!block || this.isOpenBlock(block)) continue;
        const expected = this.map.cells[x]?.[z] || null;
        if (block.name !== expected) {
          count += 1;
          if (count >= limit) return count;
        }
      }
    }
    return count;
  }

  queueResetForErrors() {
    this.warn('Resetting map because existing placements do not match current NBT.');
    this.checkpoints = [];
    this.knownErrors = [];
    if (this.settings.breakCarpetAboveReset) {
      const above = {
        x: this.carpetConfig.reset.blockPos.x,
        y: this.carpetConfig.reset.blockPos.y + 1,
        z: this.carpetConfig.reset.blockPos.z
      };
      if (this.blockAt(above)?.name?.includes('carpet')) {
        this.checkpoints.push({ goal: this.carpetConfig.reset.openPos, action: 'break', target: above });
      }
    }
    this.checkpoints.push({ goal: this.carpetConfig.reset.openPos, action: 'reset', target: this.carpetConfig.reset.blockPos });
    this.startedFiles = this.startedFiles.filter((file) => file !== this.mapFile);
  }

  handleWindowOpen(window) {
    const allowed = new Set([
      'AwaitRestockResponse',
      'AwaitMapChestResponse',
      'AwaitCartographyResponse',
      'AwaitFinishedMapChestResponse',
      'AwaitResetResponse',
      'AwaitWaterBucketPickup',
      'AwaitWaterBucketStore'
    ]);
    if (!allowed.has(this.state)) {
      if (this.state === 'Walking' && this.settings.closeUnexpectedWindows !== false) {
        this.warn(`Closing unexpected window during placement (${window?.type || window?.id || 'unknown'}).`);
        this.bot.closeWindow?.(window);
      }
      return;
    }
    this.toBeHandledWindow = window;
    this.timeoutTicks = ticksFromMs(this.settings.preRestockDelayMs);
  }

  chestSlotEnd(window) {
    return window?.inventoryStart ?? Math.max(0, (window?.slots?.length || 36) - 36);
  }

  findHighestFreeWindowInvSlot(window) {
    for (let i = (window?.slots?.length || 0) - 1; i > (window?.slots?.length || 0) - 1 - 36; i -= 1) {
      if (!window.slots[i]) return i;
    }
    return -1;
  }

  hasRestockDestination(window, itemName) {
    for (let i = (window?.slots?.length || 0) - 1; i > (window?.slots?.length || 0) - 1 - 36; i -= 1) {
      const stack = window.slots[i];
      if (!stack || (stack.name === itemName && stack.count < 64)) return true;
    }
    return false;
  }

  async clickWindow(slot, mouseButton, mode) {
    if (!this.bot.clickWindow) return;
    await this.bot.clickWindow(slot, mouseButton, mode);
  }

  async getOneItem(window, sourceSlot, avoidFirstHotBar) {
    let targetSlot = this.availableHotBarSlots[0];
    if (avoidFirstHotBar) {
      targetSlot = this.availableSlots[0];
      if (targetSlot === this.availableHotBarSlots[0]) targetSlot = this.availableSlots[1];
    }
    const windowTarget = this.javaSlotToContainerWindowSlot(targetSlot, window);
    await this.getOneItemToWindowSlot(sourceSlot, windowTarget);
  }

  async getOneItemToWindowSlot(sourceSlot, windowTarget) {
    await this.clickWindow(sourceSlot, 0, 0);
    await this.clickWindow(windowTarget, 1, 0);
    await this.clickWindow(sourceSlot, 0, 0);
  }

  async handleInventoryWindow(window) {
    if (this.settings.debugPrints) this.info(`Handling window for ${this.state}`);
    this.closeNextWindow = true;
    this.interactRetryCount = 0;
    this.interactRecoveryCycleCount = 0;
    this.lastInteractRecoveryCheckpoint = null;

    switch (this.state) {
      case 'AwaitRestockResponse': {
        this.interactTimeoutTicks = 0;
        const current = this.restockList[0];
        if (!current) {
          this.state = 'Walking';
          return;
        }

        let foundMaterials = false;
        const slots = shuffle([...Array(this.chestSlotEnd(window)).keys()]);
        for (const slot of slots) {
          if (current.stacks === 0) {
            foundMaterials = true;
            break;
          }
          const stack = window.slots[slot];
          if (stack && stack.name === current.itemName && stack.count === 64) {
            foundMaterials = true;
            if (!this.hasRestockDestination(window, current.itemName)) {
              this.warn('No free slots found in inventory.');
              this.checkpoints.unshift({ goal: this.carpetConfig.dumpStation.pos, action: 'dump' });
              this.state = 'Walking';
              return;
            }
        this.restockBacklogSlots.push(slot);
        current.stacks -= 1;
        current.rawAmount -= 64;
          }
        }
        this.info(`Restock window ${current.itemName}: queued=${this.restockBacklogSlots.length} remainingStacks=${current.stacks}`);
        if (!foundMaterials) this.endRestocking();
        break;
      }

      case 'AwaitMapChestResponse': {
        const chestEnd = this.chestSlotEnd(window);
        let mapSlot = -1;
        let paneSlot = -1;
        for (let slot = 0; slot < chestEnd; slot += 1) {
          const stack = window.slots[slot];
          if (stack?.name === MAP_ITEM) mapSlot = slot;
          if (stack?.name === GLASS_PANE_ITEM) paneSlot = slot;
        }
        if (mapSlot === -1 || paneSlot === -1) {
          this.warn('Not enough Empty Maps/Glass Panes in Map Material Chest');
          return;
        }
        this.interactTimeoutTicks = 0;
        this.timeoutTicks = ticksFromMs(this.settings.postRestockDelayMs);
        await this.getOneItem(window, mapSlot, false);
        await this.getOneItem(window, paneSlot, true);
        this.bot.setQuickBarSlot?.(this.availableHotBarSlots[0]);
        const center = {
          x: this.mapCorner().x + this.map.width / 2 - 0.5,
          y: this.mapCorner().y + 0.5,
          z: this.mapCorner().z + this.map.depth / 2 - 0.5
        };
        this.checkpoints.push({ goal: center, action: 'fillMap' });
        this.state = 'Walking';
        break;
      }

      case 'AwaitCartographyResponse': {
        this.interactTimeoutTicks = 0;
        this.timeoutTicks = ticksFromMs(this.settings.postRestockDelayMs);
        let searchingMap = true;
        for (const slot of this.availableSlots) {
          const windowSlot = this.javaSlotToContainerWindowSlot(slot, window);
          const stack = window.slots[windowSlot];
          if (searchingMap && stack?.name === FILLED_MAP_ITEM) {
            await this.clickWindow(windowSlot, 0, 1);
            searchingMap = false;
          }
        }
        for (const slot of this.availableSlots) {
          const windowSlot = this.javaSlotToContainerWindowSlot(slot, window);
          const stack = window.slots[windowSlot];
          if (!searchingMap && stack?.name === GLASS_PANE_ITEM) {
            await this.clickWindow(windowSlot, 0, 1);
            break;
          }
        }
        await this.clickWindow(2, 0, 1);
        this.checkpoints.push({ goal: this.carpetConfig.finishedMapChest.openPos, action: 'finishedMapChest' });
        this.state = 'Walking';
        break;
      }

      case 'AwaitFinishedMapChestResponse': {
        this.interactTimeoutTicks = 0;
        this.timeoutTicks = ticksFromMs(this.settings.postRestockDelayMs);
        for (let slot = this.chestSlotEnd(window); slot < window.slots.length; slot += 1) {
          const stack = window.slots[slot];
          if (stack?.name === FILLED_MAP_ITEM) {
            await this.clickWindow(slot, 0, 1);
            break;
          }
        }
        this.queueResetAfterFinishedMap();
        this.state = 'Walking';
        break;
      }

      case 'AwaitResetResponse':
        this.interactTimeoutTicks = 0;
        this.beginResetCloseWait();
        break;

      case 'AwaitWaterBucketPickup': {
        this.interactTimeoutTicks = 0;
        const chestEnd = this.chestSlotEnd(window);
        let bucketSlot = -1;
        for (let slot = 0; slot < chestEnd; slot += 1) {
          if (this.isEmptyBucketStack(window.slots[slot])) {
            bucketSlot = slot;
            break;
          }
        }
        if (bucketSlot !== -1) {
          const target = this.findHighestFreeWindowInvSlot(window);
          if (target === -1) {
            this.closeCurrentWindow();
            this.closeNextWindow = false;
            this.state = 'WaterBucketMakeRoom';
            await this.tickWaterBucketMakeRoom();
            break;
          }
          await this.getOneItemToWindowSlot(bucketSlot, target);
          if (this.waterDrainCurrent) this.waterDrainCurrent.bucketReady = true;
        } else if (!this.inventoryBucket(true)) {
          const key = this.waterDrainCurrent?.source ? posKey(this.waterDrainCurrent.source) : 'unknown';
          const waterBucketSlot = [...Array(this.chestSlotEnd(window)).keys()]
            .find((slot) => this.isWaterBucketStack(window.slots[slot]));
          const contents = [...Array(chestEnd).keys()]
            .map((slot) => window.slots[slot] ? `${slot}:${window.slots[slot].name || '?'}x${window.slots[slot].count || 1}` : `${slot}:empty`)
            .join(' ');
          this.warn(`Water dispenser slots for ${key}: ${contents}`);
          if (waterBucketSlot !== undefined) {
            const target = this.findHighestFreeWindowInvSlot(window);
            if (target === -1) {
              this.closeCurrentWindow();
              this.closeNextWindow = false;
              this.state = 'WaterBucketMakeRoom';
              await this.tickWaterBucketMakeRoom();
              break;
            }
            this.warn(`Water drain recovery: dispenser has water_bucket for ${key}; pulling it out and converting it back to bucket.`);
            await this.getOneItemToWindowSlot(waterBucketSlot, target);
            if (this.waterDrainCurrent) this.waterDrainCurrent.recovering = true;
            this.closeCurrentWindow();
            this.closeNextWindow = false;
            this.timeoutTicks = ticksFromMs(this.settings.waterDrainActionDelayMs ?? 500);
            this.state = 'WaterBucketRecover';
            break;
          }
          this.warn(`Water drain source ${key} has an empty dispenser; postponing it and draining other sources first.`);
          this.waterMissingBucketSources.add(key);
          this.closeCurrentWindow();
          this.closeNextWindow = false;
          this.waterDrainCurrent = null;
          this.state = 'AwaitAreaClear';
          break;
        }
        this.closeCurrentWindow();
        this.closeNextWindow = false;
        this.timeoutTicks = ticksFromMs(this.settings.waterDrainActionDelayMs ?? 500);
        this.state = 'WaterBucketDrain';
        break;
      }

      case 'AwaitWaterBucketStore': {
        this.setWaterDrainSneak(false, 'store');
        this.interactTimeoutTicks = 0;
        const chestEnd = this.chestSlotEnd(window);
        let carriedSlot = -1;
        let carriedName = WATER_BUCKET_ITEM;
        for (let slot = chestEnd; slot < window.slots.length; slot += 1) {
          if (this.isWaterBucketStack(window.slots[slot])) {
            carriedSlot = slot;
            break;
          }
        }
        if (carriedSlot === -1) {
          carriedName = EMPTY_BUCKET_ITEM;
          for (let slot = chestEnd; slot < window.slots.length; slot += 1) {
            if (this.isEmptyBucketStack(window.slots[slot])) {
              carriedSlot = slot;
              break;
            }
          }
        }
        if (carriedSlot !== -1) {
          const key = this.waterDrainCurrent?.source ? posKey(this.waterDrainCurrent.source) : 'unknown';
          let chestTarget = -1;
          for (let slot = 0; slot < chestEnd; slot += 1) {
            if (!window.slots[slot]) {
              chestTarget = slot;
              break;
            }
          }
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            if (chestTarget !== -1) {
              await this.clickWindow(carriedSlot, 0, 0);
              await sleep(this.settings.invActionDelayMs ?? TICK_MS);
              await this.clickWindow(chestTarget, 0, 0);
            } else {
              await this.clickWindow(carriedSlot, 0, 1);
            }
            await sleep(this.settings.invActionDelayMs ?? TICK_MS);
            if (!this.inventoryBucket(false)) break;
            const nextSlot = [...Array(window.slots.length).keys()]
              .slice(chestEnd)
              .find((slot) => this.isWaterBucketStack(window.slots[slot]));
            if (nextSlot === undefined) break;
            carriedSlot = nextSlot;
            this.warn(`Water drain store retry ${attempt} for ${key}; water_bucket still in inventory.`);
          }
          const stillCarryingWaterBucket = Boolean(this.inventoryBucket(false));
          const chestHasBucket = [...Array(chestEnd).keys()].some((slot) => this.isEmptyBucketStack(window.slots[slot]));
          const chestHasWaterBucket = [...Array(chestEnd).keys()].some((slot) => this.isWaterBucketStack(window.slots[slot]));
          if (stillCarryingWaterBucket) {
            if (chestHasBucket) {
              this.info(`Stored empty bucket back for ${key} (verified in dispenser after retry).`);
              this.waterDrainCurrent = null;
            } else if (chestHasWaterBucket) {
              this.warn(`Water drain store verify found water_bucket still in dispenser for ${key}; entering recovery.`);
              if (this.waterDrainCurrent) this.waterDrainCurrent.recovering = true;
              this.closeCurrentWindow();
              this.closeNextWindow = false;
              this.timeoutTicks = ticksFromMs(this.settings.waterDrainActionDelayMs ?? 500);
              this.state = 'WaterBucketRecover';
              break;
            } else {
              this.warn(`Water drain store verify failed for ${key}; leaving bucket cleanup to next drain.`);
            }
          } else {
            this.info(`Stored ${carriedName} back for ${key}.`);
            this.waterDrainCurrent = null;
          }
        } else {
          const key = this.waterDrainCurrent?.source ? posKey(this.waterDrainCurrent.source) : 'unknown';
          this.warn(`No bucket to store back for ${key}.`);
          this.waterDrainCurrent = null;
        }
        this.closeCurrentWindow();
        this.closeNextWindow = false;
        if (this.restoreWaterResumeStateIfClear('store cleanup')) break;
        this.timeoutTicks = ticksFromMs(this.settings.waterDrainActionDelayMs ?? 500);
        this.state = 'AwaitAreaClear';
        break;
      }

      default:
        break;
    }
  }

  closeCurrentWindow() {
    if (this.bot.currentWindow && this.bot.closeWindow) {
      this.bot.closeWindow(this.bot.currentWindow);
    }
  }

  hasFilledMapInInventory() {
    for (const slot of this.availableSlots.length > 0 ? this.availableSlots : [...Array(36).keys()]) {
      if (this.stackInJavaSlot(slot)?.name === FILLED_MAP_ITEM) return true;
    }
    return (this.bot.inventory?.items?.() || []).some((stack) => stack?.name === FILLED_MAP_ITEM);
  }

  queueResetAfterFinishedMap() {
    if (this.settings.breakCarpetAboveReset) {
      const above = {
        x: this.carpetConfig.reset.blockPos.x,
        y: this.carpetConfig.reset.blockPos.y + 1,
        z: this.carpetConfig.reset.blockPos.z
      };
      const block = this.blockAt(above);
      if (block?.name?.includes('carpet')) {
        this.checkpoints.push({ goal: this.carpetConfig.reset.openPos, action: 'break', target: above });
      }
    }
    this.checkpoints.push({ goal: this.carpetConfig.reset.openPos, action: 'reset', target: this.carpetConfig.reset.blockPos });
  }

  boostResetViewDistance() {
    const viewDistance = this.settings.resetViewDistance;
    if (!this.bot.setSettings || !viewDistance || viewDistance <= 0) return;
    if (this.savedViewDistance === null) this.savedViewDistance = this.bot.settings?.viewDistance ?? this.config.bot?.viewDistance ?? 2;
    this.bot.setSettings({ viewDistance });
  }

  restoreResetViewDistance() {
    if (this.savedViewDistance === null || !this.bot.setSettings) return;
    this.bot.setSettings({ viewDistance: this.savedViewDistance });
    this.savedViewDistance = null;
  }

  beginResetCloseWait() {
    this.closeNextWindow = false;
    this.interactTimeoutTicks = 0;
    this.boostResetViewDistance();
    this.closeResetChestTicks = ticksFromMs(this.settings.resetChestCloseDelayMs);
    if (this.closeResetChestTicks === 0) this.queueAwaitClearAfterReset();
  }

  queueAwaitClearAfterReset() {
    this.closeCurrentWindow();
    const center = {
      x: this.mapCorner().x + this.map.width / 2 + 0.5,
      y: this.mapCorner().y + 0.5,
      z: this.mapCorner().z + this.map.depth / 2 + 0.5
    };
    this.checkpoints.unshift({ goal: center, action: 'awaitClear' });
    this.state = 'Walking';
    this.info('close reset chest; walking to map center before water check');
  }

  faceYawAt(goal) {
    const botPos = this.bot.entity.position;
    const dx = goal.x - botPos.x;
    const dz = goal.z - botPos.z;
    return Math.atan2(-dx, -dz);
  }

  stopMovement() {
    if (this.pathfinderGoalKey) {
      this.bot.pathfinder?.setGoal?.(null);
      this.pathfinderGoalKey = null;
    }
    this.restorePhysicsAfterPacketPrint();
    this.bot.setControlState?.('forward', false);
    this.bot.setControlState?.('sprint', false);
  }

  steerToward(goal, action, forcePathfinder = false) {
    this.ensureUnsneakingWhileWalking();
    const canUsePathfinder = Boolean(this.bot.pathfinder?.setGoal && goals?.GoalNear);
    const forcedInteractPath = forcePathfinder && canUsePathfinder && !this.isPrintCheckpointAction(action);
    const now = Date.now();
    const stalledInteractPath =
      !forcePathfinder &&
      this.shouldUsePathfinder(action) &&
      now - this.lastWalkingProgressAt > (this.settings.walkingStallMs ?? 15000);
    if (stalledInteractPath) {
      this.interactRecoveryUntil = now + Math.max(TICK_MS, this.settings.interactRecoveryMs ?? 3000);
      if (this.pathfinderGoalKey) {
        this.bot.pathfinder?.setGoal?.(null);
        this.pathfinderGoalKey = null;
      }
      if (now - this.lastPathfinderStallLogAt > (this.settings.progressLogMs ?? 30000)) {
        this.lastPathfinderStallLogAt = now;
        this.warn(`Pathfinder stalled for ${action}; packet walking to recover.`);
      }
    }
    if (!forcePathfinder && this.shouldUsePathfinder(action) && this.interactRecoveryUntil > now) {
      if (this.pathfinderGoalKey) {
        this.bot.pathfinder?.setGoal?.(null);
        this.pathfinderGoalKey = null;
      }
      if (this.bot._client?.write) {
        this.packetPrintStepToward(goal);
        return;
      }
    } else if (this.shouldUsePathfinder(action) || forcedInteractPath) {
      this.restorePhysicsAfterPacketPrint();
      const buffer = forcedInteractPath
        ? Math.max(this.checkpointBuffer({ goal, action }), 0.8)
        : this.checkpointBuffer({ goal, action });
      const mode = forcedInteractPath ? `recover:${action}` : action;
      const key = `${mode}:${goal.x.toFixed(2)},${goal.y.toFixed(2)},${goal.z.toFixed(2)}:${buffer.toFixed(2)}`;
      if (this.bot.pathfinder.movements) {
        this.bot.pathfinder.movements.allowSprinting = this.shouldSprint(action);
      }
      if (key !== this.pathfinderGoalKey) {
        this.pathfinderGoalKey = key;
        this.info(
          `Pathing to ${forcedInteractPath ? 'recover' : action} ` +
          `(${goal.x.toFixed(2)},${goal.y.toFixed(2)},${goal.z.toFixed(2)})`
        );
        this.bot.pathfinder.setGoal(new goals.GoalNear(goal.x, goal.y, goal.z, buffer));
      }
      return;
    }
    if (this.pathfinderGoalKey) {
      this.bot.pathfinder?.setGoal?.(null);
      this.pathfinderGoalKey = null;
    }
    if (this.shouldUsePacketPrintMovement(action)) {
      this.packetPrintStepToward(goal);
      return;
    }
    this.restorePhysicsAfterPacketPrint();
    this.bot.look?.(this.faceYawAt(goal), this.bot.entity.pitch || 0, true).catch?.(() => {});
    this.bot.setControlState?.('forward', true);
    this.bot.setControlState?.('sprint', this.shouldSprint(action));
  }

  ensureUnsneakingWhileWalking() {
    if (this.settings.unsneakWhileWalking === false) return;
    if (this.bot.getControlState?.('sneak')) {
      this.bot.setControlState?.('sneak', false);
    }
    const now = Date.now();
    if (now - this.lastUnsneakAt < 1000) return;
    this.lastUnsneakAt = now;
    this.sendServerSneakPacket(false);
  }

  shouldUsePacketPrintMovement(action) {
    return Boolean(
      this.settings.packetPrintMovement &&
      this.bot._client?.write &&
      this.isPrintCheckpointAction(action)
    );
  }

  restorePhysicsAfterPacketPrint() {
    if (!this.packetPrintMovementActive) return;
    this.packetPrintMovementActive = false;
    this.lastPacketPrintMoveAt = 0;
    if (this.bot.physicsEnabled === false) this.bot.physicsEnabled = true;
  }

  packetPrintStepToward(goal) {
    const entity = this.bot.entity;
    if (!entity?.position || !this.bot._client?.write) return;
    this.bot.setControlState?.('forward', false);
    this.bot.setControlState?.('sprint', false);
    this.bot.setControlState?.('sneak', false);
    if (this.bot.physicsEnabled !== false) this.bot.physicsEnabled = false;
    this.packetPrintMovementActive = true;

    const now = Date.now();
    const elapsedMs = this.lastPacketPrintMoveAt > 0 ? now - this.lastPacketPrintMoveAt : TICK_MS;
    this.lastPacketPrintMoveAt = now;

    const dx = goal.x - entity.position.x;
    const dz = goal.z - entity.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance <= 0.001) return;

    const speed = Math.max(0.1, this.settings.packetPrintSpeed ?? 5.6);
    const maxStep = Math.max(0.05, this.settings.packetPrintMaxStep ?? 0.45);
    const step = Math.min(distance, maxStep, speed * Math.max(TICK_MS, elapsedMs) / 1000);
    const nx = entity.position.x + dx / distance * step;
    const nz = entity.position.z + dz / distance * step;
    const nextPosition = new Vec3(nx, entity.position.y, nz);
    const yaw = Math.atan2(-dx, -dz);

    entity.position = nextPosition;
    entity.yaw = yaw;
    entity.onGround = true;
    const packet = {
      x: nextPosition.x,
      y: nextPosition.y,
      z: nextPosition.z,
      yaw: Math.fround(toNotchianYawRadians(yaw)),
      pitch: Math.fround(toNotchianPitchRadians(entity.pitch || 0)),
      onGround: true,
      flags: { onGround: true, hasHorizontalCollision: false }
    };
    this.bot._client.write('position_look', packet);
  }

  shouldUsePathfinder(action) {
    return Boolean(
      this.settings.pathfinderForInteractTravel &&
      this.bot.pathfinder?.setGoal &&
      goals?.GoalNear &&
      INTERACT_CHECKPOINT_ACTIONS.has(action)
    );
  }

  isPrintCheckpointAction(action) {
    return PRINT_CHECKPOINT_ACTIONS.has(action);
  }

  shouldSprint(action) {
    if (this.settings.sprintMode === 'Off') return false;
    if (this.bot.food !== undefined && this.bot.food <= (this.settings.sprintMinFood ?? 6)) return false;
    if (this.settings.sprintMode === 'Always') return true;
    return !(action === '' || action === 'lineEnd');
  }

  checkpointDistance(goal) {
    const botPos = this.bot.entity.position;
    const dx = goal.x - botPos.x;
    const dz = goal.z - botPos.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  checkpointBuffer(checkpoint) {
    const base = Math.max(this.settings.checkpointBuffer, this.settings.minCheckpointBuffer ?? 0);
    if (INTERACT_CHECKPOINT_ACTIONS.has(checkpoint.action)) {
      return Math.max(base, this.settings.interactCheckpointBuffer ?? 0.85);
    }
    return base;
  }

  checkpointReached(checkpoint) {
    const buffer = this.checkpointBuffer(checkpoint);
    const distance = this.checkpointDistance(checkpoint.goal);
    const key = `${checkpoint.action || ''}:${checkpoint.goal.x.toFixed(3)},${checkpoint.goal.z.toFixed(3)}`;
    const initialAxis = this.checkpointDominantAxis(checkpoint.goal);
    if (key !== this.checkpointKey) {
      this.checkpointKey = key;
      this.checkpointBestDistance = distance;
      this.lastWalkingProgressAt = Date.now();
      this.interactRecoveryUntil = 0;
      this.checkpointAxis = initialAxis;
      this.checkpointAxisOffset = this.checkpointAxisDistance(checkpoint.goal, initialAxis);
      return distance < buffer;
    }

    const axis = this.checkpointAxis || initialAxis;
    const offset = this.checkpointAxisDistance(checkpoint.goal, axis);
    const crossedCheckpoint = this.printCheckpointPassed(checkpoint, axis, offset);
    if (distance < this.checkpointBestDistance - 0.25) this.lastWalkingProgressAt = Date.now();
    this.checkpointBestDistance = Math.min(this.checkpointBestDistance, distance);
    return distance < buffer || crossedCheckpoint;
  }

  checkpointDominantAxis(goal) {
    const botPos = this.bot.entity.position;
    return Math.abs(goal.x - botPos.x) >= Math.abs(goal.z - botPos.z) ? 'x' : 'z';
  }

  checkpointAxisDistance(goal, axis) {
    const botPos = this.bot.entity.position;
    return axis === 'x' ? botPos.x - goal.x : botPos.z - goal.z;
  }

  checkpointCrossDistance(goal, axis) {
    const botPos = this.bot.entity.position;
    return axis === 'x' ? Math.abs(botPos.z - goal.z) : Math.abs(botPos.x - goal.x);
  }

  printCheckpointPassed(checkpoint, axis, offset) {
    if (!this.isPrintCheckpointAction(checkpoint.action)) return false;
    if (!this.checkpointAxis || this.checkpointAxisOffset === null) return false;
    if (axis !== this.checkpointAxis) return false;

    const previousOffset = this.checkpointAxisOffset;
    this.checkpointAxisOffset = offset;
    const crossed =
      previousOffset === 0 ||
      offset === 0 ||
      Math.sign(previousOffset) !== Math.sign(offset);
    if (!crossed) return false;

    const sideTolerance = Math.max(
      this.settings.printCheckpointSideTolerance ?? 1.5,
      this.settings.minCheckpointBuffer ?? 0.2
    );
    return this.checkpointCrossDistance(checkpoint.goal, axis) <= sideTolerance;
  }

  async interactWithBlock(blockPos, options = {}) {
    this.stopMovement();
    if (this.bot.entity) this.bot.entity.velocity = new Vec3(0, 0, 0);
    const block = this.blockAt(blockPos);
    if (!block) {
      this.warn(`Cannot see block at ${posKey(blockPos)}`);
      return;
    }
    await this.bot.lookAt?.(centerOf(blockPos), true);
    if (options.preferActivate && this.bot.activateBlock) {
      const recoveryAction = options.recoveryCheckpoint?.action;
      const faces = options.preferFaceVector
        ? [options.preferFaceVector, ...this.interactionFaceVectors(blockPos)]
        : options.preferTopFace
          ? [new Vec3(0, 1, 0), ...this.interactionFaceVectors(blockPos)]
        : this.interactionFaceVectors(blockPos);
      if (options.preferContainerOpen) {
        const openResult = await this.tryOpenContainerBlock(block, faces[0], {
          leftClickOnly: recoveryAction === 'waterBucketPickup' || recoveryAction === 'waterBucketStore'
        });
        if (openResult?.status === 'opened' && openResult.window) {
          this.toBeHandledWindow ||= openResult.window;
        } else if (
          openResult?.status === 'failed' &&
          (recoveryAction === 'waterBucketPickup' || recoveryAction === 'waterBucketStore')
        ) {
          if (recoveryAction === 'waterBucketPickup') {
            this.info(`Water open cycle failed at ${posKey(blockPos)}; skipping source.`);
            this.blockWaterDrainOpenFailure();
          } else {
            this.info(`Water store open cycle failed at ${posKey(blockPos)}; skipping store retry loop.`);
            await this.handleWaterStoreOpenFailure();
          }
          return false;
        }
      }
      if (!this.toBeHandledWindow && !this.bot.currentWindow) {
        if (this.bot._client?.write && this.bot.supportFeature) {
          this.sendUseBlockPacket(block.position || toVec3(blockPos), faces[0]);
        }
        await this.bot.activateBlock(block, faces[0], this.cursorForFace(faces[0]))
          .catch((error) => this.warn(`Interact failed at ${posKey(blockPos)}: ${error.message}`));
        if (!this.toBeHandledWindow && !this.bot.currentWindow && this.bot._client?.write && this.bot.supportFeature) {
          this.sendUseBlockPacket(block.position || toVec3(blockPos), faces[1] || faces[0]);
        }
      }
    } else if (this.bot._client?.write && this.bot.supportFeature) {
      this.sendUseBlockPacket(block.position || toVec3(blockPos), new Vec3(0, 1, 0));
    } else if (this.bot.activateBlock) {
      this.bot.activateBlock(block).catch((error) => this.warn(`Interact failed at ${posKey(blockPos)}: ${error.message}`));
    }
    this.interactTimeoutTicks = ticksFromMs(this.settings.retryInteractMs);
    this.lastInteractedBlockPos = clonePos(blockPos);
    this.lastInteractPreferActivate = Boolean(options.preferActivate);
    this.lastInteractPreferContainerOpen = Boolean(options.preferContainerOpen);
    this.lastInteractPreferTopFace = Boolean(options.preferTopFace);
    this.lastInteractPreferFaceVector = options.preferFaceVector || null;
    if (options.recoveryCheckpoint) {
      this.lastInteractRecoveryCheckpoint = {
        ...options.recoveryCheckpoint,
        goal: clonePos(options.recoveryCheckpoint.goal),
        target: clonePos(options.recoveryCheckpoint.target),
        dispenser: options.recoveryCheckpoint.dispenser ? clonePos(options.recoveryCheckpoint.dispenser) : undefined,
        access: options.recoveryCheckpoint.access
      };
    }
    return true;
  }

  async tryOpenContainerBlock(block, faceVector, options = {}) {
    const timeoutMs = Math.max(1000, this.settings.waterDrainOpenTimeoutMs ?? 5000);
    const maxAttempts = Math.max(6, Math.floor(this.settings.waterDrainOpenMaxAttempts ?? 16));
    const faces = this.uniqueFaceVectors([
      faceVector,
      ...this.interactionFaceVectors(block.position || block),
      new Vec3(0, 1, 0),
      new Vec3(0, -1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1)
    ].filter(Boolean));
    try {
      this.info(
        `Opening ${block.name} at ${posKey(block.position || block)} ` +
        `d=${distance3d(this.bot.entity.position, centerOf(block.position || block)).toFixed(2)} faces=${faces.map(vectorToDirection).join(',')}`
      );
      if (options.leftClickOnly) {
        const opened = await this.tryLeftClickFallback(block, faces, 'dispenser open (left-click only)');
        if (opened) {
          if (this.toBeHandledWindow) return { status: 'opened', window: this.toBeHandledWindow };
          if (this.bot.currentWindow) return { status: 'opened', window: this.bot.currentWindow };
        }
        return { status: 'failed' };
      }
      const deadline = Date.now() + timeoutMs;
      let attempt = 0;
      this.setWaterDrainSneak(false, 'open');
      while (Date.now() < deadline && attempt < maxAttempts) {
        if (this.waterDrainCurrent?.source) {
          this.waterDrainCurrent.openAnchorIndex = Math.floor(attempt / faces.length);
        }
        this.anchorLiquidAntiVelocity();
        const face = faces[attempt % faces.length];
        const pos = this.bot.entity?.position;
        this.info(
          `Open attempt ${attempt + 1}: face=${vectorToDirection(face)} ` +
          `pos=${pos ? `${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}` : 'unknown'} ` +
          `d=${pos ? distance3d(pos, centerOf(block.position || block)).toFixed(2) : 'unknown'} ` +
          `sneak=${this.bot.getControlState?.('sneak') || false} held=${this.bot.heldItem?.name || 'none'} ` +
          `window=${this.bot.currentWindow?.type || this.toBeHandledWindow?.type || 'none'}`
        );
        if (this.bot._client?.write && this.bot.supportFeature) {
          this.sendUseBlockPacket(block.position || toVec3(block), face);
        }
        if (this.bot.activateBlock) {
          await Promise.race([
            Promise.resolve(this.bot.activateBlock(block, face, this.cursorForFace(face))).catch(() => {}),
            sleep(250)
          ]);
        }
        await sleep(250);
        if (this.toBeHandledWindow) {
          return { status: 'opened', window: this.toBeHandledWindow };
        }
        if (this.bot.currentWindow) {
          return { status: 'opened', window: this.bot.currentWindow };
        }
        attempt += 1;
      }
      await this.tryLeftClickFallback(block, faces, 'dispenser open');
      if (this.toBeHandledWindow) return { status: 'opened', window: this.toBeHandledWindow };
      if (this.bot.currentWindow) return { status: 'opened', window: this.bot.currentWindow };
      return { status: 'failed' };
    } catch (error) {
      this.warn(`Container open failed at ${posKey(block.position || block)}: ${error.message}`);
      return { status: 'failed' };
    } finally {
      if (this.waterDrainCurrent) this.waterDrainCurrent.openAnchorIndex = null;
    }
  }

  async tryLeftClickFallback(block, faces, reason) {
    if (!this.bot._client?.write) return false;
    const location = block.position || toVec3(block);
    this.warn(`Water drain fallback: literal left-click for ${reason} at ${posKey(location)}.`);
    for (const face of faces) {
      this.anchorLiquidAntiVelocity();
      this.bot._client.write('block_dig', {
        status: 0,
        location,
        face: vectorToDirection(face)
      });
      this.bot.swingArm?.('right');
      await this.sleepWaterAnchored(100);
      this.bot._client.write('block_dig', {
        status: 1,
        location,
        face: vectorToDirection(face)
      });
      if (this.toBeHandledWindow || this.bot.currentWindow) return true;
    }
    return false;
  }

  async sleepWaterAnchored(ms) {
    const end = Date.now() + Math.max(0, ms);
    do {
      this.anchorLiquidAntiVelocity();
      await sleep(Math.min(50, Math.max(0, end - Date.now())));
    } while (Date.now() < end);
    this.anchorLiquidAntiVelocity();
  }

  uniqueFaceVectors(faces) {
    const seen = new Set();
    const result = [];
    for (const face of faces) {
      const key = `${face.x},${face.y},${face.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(face);
    }
    return result;
  }

  interactionFaceVectors(blockPos) {
    const pos = this.bot.entity?.position;
    if (!pos) return [new Vec3(0, 1, 0), new Vec3(0, 0, -1)];
    const dx = pos.x - (blockPos.x + 0.5);
    const dz = pos.z - (blockPos.z + 0.5);
    const horizontal = Math.abs(dx) >= Math.abs(dz)
      ? new Vec3(dx >= 0 ? 1 : -1, 0, 0)
      : new Vec3(0, 0, dz >= 0 ? 1 : -1);
    return [horizontal, new Vec3(0, 1, 0), new Vec3(0, 0, -1)];
  }

  cursorForFace(faceVector) {
    return new Vec3(
      0.5 + faceVector.x * 0.5,
      0.5 + faceVector.y * 0.5,
      0.5 + faceVector.z * 0.5
    );
  }

  sendUseBlockPacket(location, faceVector, cursor = null, options = {}) {
    const client = this.bot._client;
    if (!client?.write || !this.bot.supportFeature) return false;
    this.waterUseSequence = (this.waterUseSequence || 0) + 1;
    const cursorX = cursor?.x ?? (0.5 + faceVector.x * 0.5);
    const cursorY = cursor?.y ?? (0.5 + faceVector.y * 0.5);
    const cursorZ = cursor?.z ?? (0.5 + faceVector.z * 0.5);
    const packet = {
      location,
      direction: vectorToDirection(faceVector),
      hand: 0,
      cursorX,
      cursorY,
      cursorZ
    };
    if (this.bot.supportFeature('blockPlaceHasInsideBlock')) {
      client.write('block_place', {
        ...packet,
        insideBlock: Boolean(options.insideBlock),
        sequence: this.waterUseSequence,
        worldBorderHit: false
      });
    } else if (this.bot.supportFeature('blockPlaceHasHandAndFloatCursor')) {
      client.write('block_place', packet);
    } else {
      return false;
    }
    this.bot.swingArm?.('right');
    return true;
  }

  sendUseItemPacket() {
    const client = this.bot._client;
    if (!client?.write || !this.bot.supportFeature?.('useItemWithOwnPacket')) return false;
    this.waterUseSequence = (this.waterUseSequence || 0) + 1;
    client.write('use_item', {
      hand: 0,
      sequence: this.waterUseSequence,
      rotation: {
        x: Math.fround(toNotchianYawRadians(this.bot.entity?.yaw || 0)),
        y: Math.fround(toNotchianPitchRadians(this.bot.entity?.pitch || 0))
      }
    });
    this.bot.swingArm?.('right');
    return true;
  }


  async tickDumping() {
    this.stopMovement();
    await this.bot.look?.(
      fromNotchianYawDegrees(this.carpetConfig.dumpStation.yaw),
      fromNotchianPitchDegrees(this.carpetConfig.dumpStation.pitch),
      true
    );
    const dump = this.getDumpStack();
    if (!dump) {
      const required = this.getActiveRestockTargetItems();
      const { counts } = this.getInventoryMaterialInfo(required);
      this.refillInventory(counts);
      this.state = 'Walking';
      return;
    }
    this.info(`Dumping ${dump.stack.name} (${dump.stack.count})`);
    await this.bot.tossStack?.(dump.stack);
    this.timeoutTicks = ticksFromMs(this.settings.invActionDelayMs);
  }

  async tickBlockBreak() {
    if (!this.miningPos || this.isAirAt(this.miningPos)) {
      this.miningPos = null;
      this.state = 'Walking';
      return;
    }
    const block = this.blockAt(this.miningPos);
    if (!block) return;
    this.stopMovement();
    await this.bot.lookAt?.(centerOf(this.miningPos), true);
    await this.bot.dig?.(block, true);
  }

  async tickWaterBucketDrain() {
    const current = this.waterDrainCurrent;
    if (!current) {
      if (this.restoreWaterResumeStateIfClear('water drain complete')) return;
      this.state = 'AwaitAreaClear';
      return;
    }

    const sourceBlock = this.blockAt(current.source);
    const hasWater = this.isWaterSourceBlock(sourceBlock);
    const bucket = this.inventoryBucket(true);
    if (!bucket && hasWater) {
      this.warn(`No empty bucket in inventory to drain ${posKey(current.source)}.`);
      this.state = 'AwaitAreaClear';
      return;
    }

    this.stopMovement();
    this.zeroVelocityForResetWater();
    try {
      if (hasWater) {
        this.info(`Water drain start source=${posKey(current.source)} dispenser=${posKey(current.dispenser)}`);
        await this.tryUseBucketOnWater(sourceBlock, bucket, current.source);
      }
      const verifyChecks = Math.max(1, Math.floor(this.settings.waterDrainVerifyChecks ?? 3));
      const verifyDelay = Math.max(0, Math.floor((this.settings.waterDrainVerifyMs ?? 1500) / verifyChecks));
      let stillWater = this.isWaterSourceBlock(this.blockAt(current.source));
      for (let i = 0; stillWater && i < verifyChecks; i += 1) {
        if (verifyDelay > 0) await this.sleepWaterAnchored(verifyDelay);
        stillWater = this.isWaterSourceBlock(this.blockAt(current.source));
      }
      if (stillWater && !this.inventoryBucket(false)) {
        this.warn(`Water drain blocked: source still water and no water_bucket after pickup at ${posKey(current.source)}.`);
        this.state = 'WaterDrainBlocked';
        return;
      }
      if (stillWater && this.inventoryBucket(false)) {
        const key = posKey(current.source);
        this.warn(`Water drain blocked: source still water after verify at ${key}.`);
        this.state = 'WaterDrainBlocked';
        return;
      } else {
        this.info(`Water drain clear confirmed at ${posKey(current.source)}.`);
        this.waterDrainAttempts.delete(posKey(current.source));
        this.waterMissingBucketSources.delete(posKey(current.source));
      }
      if (!this.inventoryBucket(false)) {
        this.info(`Water drain clear but no water_bucket found; keeping carried bucket and continuing.`);
        if (this.restoreWaterResumeStateIfClear('drain clear without bucket')) return;
        this.state = 'AwaitAreaClear';
        return;
      }
      this.checkpoints.unshift({
        goal: this.waterDrainPickupGoal(current.source),
        action: 'waterBucketStore',
        target: clonePos(current.source),
        dispenser: clonePos(current.dispenser),
        access: current.access || 'top'
      });
      this.state = 'Walking';
    } catch (error) {
      this.warn(`Water drain failed at ${posKey(current.source)}: ${error.message}`);
      this.state = 'AwaitAreaClear';
    }
  }

  async tickWaterBucketRecover() {
    const current = this.waterDrainCurrent;
    if (!current) {
      if (this.restoreWaterResumeStateIfClear('water bucket recover complete')) return;
      this.state = 'AwaitAreaClear';
      return;
    }

    const carriedWaterBucket = this.inventoryBucket(false);
    if (!carriedWaterBucket) {
      if (this.inventoryBucket(true)) {
        const sourceStillWater = this.isWaterSourceBlock(this.blockAt(current.source));
        if (sourceStillWater) {
          this.info(`Water drain recovery complete for ${posKey(current.source)}; empty bucket ready.`);
          this.state = 'WaterBucketDrain';
          this.timeoutTicks = ticksFromMs(this.settings.waterDrainActionDelayMs ?? 500);
          return;
        }
        this.info(`Water drain recovery complete for ${posKey(current.source)}; source already clear, storing empty bucket back.`);
        this.checkpoints.unshift({
          goal: this.waterDrainPickupGoal(current.source),
          action: 'waterBucketStore',
          target: clonePos(current.source),
          dispenser: clonePos(current.dispenser),
          access: current.access || 'top'
        });
        this.state = 'Walking';
        return;
      }
      this.warn(`Water drain recovery blocked: no carried water_bucket and no empty bucket for ${posKey(current.source)}.`);
      this.state = 'WaterDrainBlocked';
      return;
    }

    this.stopMovement();
    this.zeroVelocityForResetWater();
    const dispenserBlock = this.blockAt(current.dispenser);
    if (!dispenserBlock) {
      this.warn(`Water drain recovery blocked: cannot see dispenser at ${posKey(current.dispenser)}.`);
      this.state = 'WaterDrainBlocked';
      return;
    }

    await this.equipInventoryItemForWaterDrain(WATER_BUCKET_ITEM, carriedWaterBucket);
    this.setWaterDrainSneak(false, 'recover');
    const delay = this.settings.waterDrainActionDelayMs ?? 500;
    const faces = this.uniqueFaceVectors([
      current.access === 'under' ? new Vec3(0, -1, 0) : null,
      ...this.interactionFaceVectors(current.dispenser),
      new Vec3(0, -1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
      new Vec3(0, 1, 0)
    ].filter(Boolean));

    for (let attempt = 0; attempt < faces.length; attempt += 1) {
      const face = faces[attempt];
      if (current.access === 'under' && vectorToDirection(face) === vectorToDirection(new Vec3(0, -1, 0))) {
        this.snapToWaterDrainUnder(current.source);
      } else {
        this.snapToWaterDrainOpenGoal(current.source, attempt);
      }
      this.anchorLiquidAntiVelocity();
      await this.bot.lookAt?.(centerOf(current.dispenser), true);
      this.info(`Water recover attempt ${attempt + 1}: face=${vectorToDirection(face)} held=${this.bot.heldItem?.name || 'none'}`);
      if (this.bot._client?.write && this.bot.supportFeature) {
        this.sendUseBlockPacket(dispenserBlock.position || toVec3(current.dispenser), face, this.cursorForFace(face));
      }
      if (this.bot.activateBlock) {
        await Promise.race([
          Promise.resolve(this.bot.activateBlock(dispenserBlock, face, this.cursorForFace(face))).catch(() => {}),
          sleep(250)
        ]);
      }
      await this.sleepWaterAnchored(delay);
      if (this.inventoryBucket(true) && !this.inventoryBucket(false)) {
        const sourceStillWater = this.isWaterSourceBlock(this.blockAt(current.source));
        if (sourceStillWater) {
          this.info(`Water recover turned held water_bucket into empty bucket for ${posKey(current.source)}.`);
          this.state = 'WaterBucketDrain';
          this.timeoutTicks = ticksFromMs(this.settings.waterDrainActionDelayMs ?? 500);
          return;
        }
        this.info(`Water recover turned held water_bucket into empty bucket for ${posKey(current.source)}; source already clear, storing bucket.`);
        this.checkpoints.unshift({
          goal: this.waterDrainPickupGoal(current.source),
          action: 'waterBucketStore',
          target: clonePos(current.source),
          dispenser: clonePos(current.dispenser),
          access: current.access || 'top'
        });
        this.state = 'Walking';
        return;
      }
    }

    this.warn(`Water drain recovery failed for ${posKey(current.source)} after bounded attempts.`);
    this.state = 'WaterDrainBlocked';
  }

  async tryUseBucketOnWater(sourceBlock, bucket, sourcePos) {
    try {
      await this.equipInventoryItemForWaterDrain(EMPTY_BUCKET_ITEM, bucket);
      await this.sleepWaterAnchored(250);
      if (!this.isEmptyBucketStack(this.bot.heldItem)) {
        this.warn(`Water drain bucket equip not confirmed; held=${this.bot.heldItem?.name || 'none'}.`);
      }
      await this.bot.lookAt?.(centerOf(sourcePos), true);
      const faces = this.uniqueFaceVectors([
        new Vec3(0, 1, 0),
        new Vec3(0, -1, 0),
        ...this.interactionFaceVectors(sourcePos),
        new Vec3(1, 0, 0),
        new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1),
        new Vec3(0, 0, -1)
      ]);
      const delay = this.settings.waterDrainActionDelayMs ?? 500;
      this.setWaterDrainSneak(true, 'pickup');
      const anchorModes = ['source', 'side'];
      for (const anchorMode of anchorModes) {
        if (this.waterDrainCurrent) this.waterDrainCurrent.pickupAnchor = anchorMode;
        const lookTargets = [
          centerOf(sourcePos),
          toVec3(sourcePos).offset(0.5, 0.15, 0.5),
          toVec3(sourcePos).offset(0.5, 0.95, 0.5)
        ];
        for (const face of faces) {
          this.anchorLiquidAntiVelocity();
          const lookTarget = lookTargets[vectorToDirection(face) % lookTargets.length];
          await this.bot.lookAt?.(lookTarget, true);
          const pos = this.bot.entity?.position;
          this.info(
            `Water pickup attempt anchor=${anchorMode} face=${vectorToDirection(face)} ` +
            `pos=${pos ? `${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)}` : 'unknown'} ` +
            `held=${this.bot.heldItem?.name || 'none'} sneak=${this.bot.getControlState?.('sneak') || false}`
          );
          this.bot.activateItem?.();
          await this.sleepWaterAnchored(delay);
          if (!this.isWaterSourceBlock(this.blockAt(sourcePos)) || this.inventoryBucket(false)) return true;
          if (this.bot._client?.write && this.bot.supportFeature) {
            await this.bot.lookAt?.(lookTarget, true);
            this.sendUseBlockPacket(sourceBlock.position || toVec3(sourcePos), face, new Vec3(0.5, 0.5, 0.5), {
              insideBlock: anchorMode === 'source'
            });
          }
          if (this.bot.activateBlock) {
            await this.bot.activateBlock(sourceBlock, face, new Vec3(0.5, 0.5, 0.5)).catch(() => {});
          }
          await this.sleepWaterAnchored(delay);
          this.anchorLiquidAntiVelocity();
          if (!this.isWaterSourceBlock(this.blockAt(sourcePos)) || this.inventoryBucket(false)) return true;
        }
      }
      this.warn(`Water drain fallback: literal left-click for water pickup at ${posKey(sourcePos)}.`);
      if (this.bot._client?.write) {
        const location = sourceBlock.position || toVec3(sourcePos);
        for (const face of faces) {
          this.anchorLiquidAntiVelocity();
          this.bot._client.write('block_dig', { status: 0, location, face: vectorToDirection(face) });
          this.bot.swingArm?.('right');
          await this.sleepWaterAnchored(100);
          this.bot._client.write('block_dig', { status: 1, location, face: vectorToDirection(face) });
          if (!this.isWaterSourceBlock(this.blockAt(sourcePos)) || this.inventoryBucket(false)) return true;
        }
      }
      return false;
    } finally {
      if (this.waterDrainCurrent) this.waterDrainCurrent.pickupAnchor = null;
      this.setWaterDrainSneak(false, 'pickup cleanup');
    }
  }

  setWaterDrainSneak(state, reason) {
    if (state) this.info(`Water drain pickup: sneaking for bucket use (${reason}).`);
    else this.info(`Water drain store/open: unsneaked (${reason}).`);
    this.bot.setControlState?.('sneak', state);
    this.sendServerSneakPacket(state);
  }

  async equipInventoryItemForWaterDrain(itemName, item = null) {
    const slot = this.javaSlotForItem(itemName);
    if (slot >= 0) {
      const hotbarSlot = slot <= 8 ? slot : await this.swapIntoHotbar(slot);
      this.bot.setQuickBarSlot?.(hotbarSlot);
      await this.sleepWaterAnchored(100);
    }
    const stack = item || this.inventoryItem(itemName);
    if (stack && this.bot.equip) {
      await this.bot.equip(stack, 'hand').catch((error) => {
        this.warn(`Water drain equip ${itemName} failed: ${error.message}`);
      });
    }
  }

  async selectWaterDispenserOpenHand(reason = 'open') {
    const held = this.bot.heldItem;
    if (held && !this.isWaterBucketStack(held) && !this.isEmptyBucketStack(held) && !this.isCarpetStack(held)) return;
    for (let slot = 0; slot < 9; slot += 1) {
      const stack = this.stackInJavaSlot(slot);
      if (stack?.name && !this.isWaterBucketStack(stack) && !this.isEmptyBucketStack(stack)) {
        this.info(`Water drain ${reason}: switching hand to ${stack.name} before opening dispenser.`);
        this.bot.setQuickBarSlot?.(slot);
        await this.sleepWaterAnchored(150);
        return;
      }
    }
    for (let slot = 0; slot < 9; slot += 1) {
      if (!this.stackInJavaSlot(slot)) {
        this.info(`Water drain ${reason}: switching hand to empty slot before opening dispenser.`);
        this.bot.setQuickBarSlot?.(slot);
        await this.sleepWaterAnchored(150);
        return;
      }
    }
    this.info(`Water drain ${reason}: no safe hotbar slot found; opening with held=${held?.name || 'none'}.`);
  }

  async selectWaterPickupOpenHand() {
    if (this.bot.heldItem && !this.isWaterBucketStack(this.bot.heldItem)) return;
    for (let slot = 0; slot < 9; slot += 1) {
      const stack = this.stackInJavaSlot(slot);
      if (stack?.name && !this.isWaterBucketStack(stack) && !this.isEmptyBucketStack(stack)) {
        this.info(`Water drain pickup open: holding ${stack.name} before opening dispenser.`);
        this.bot.setQuickBarSlot?.(slot);
        await this.sleepWaterAnchored(150);
        return;
      }
    }
    const invStack = (this.bot.inventory?.items?.() || [])
      .find((stack) => stack?.name && !this.isWaterBucketStack(stack) && !this.isEmptyBucketStack(stack));
    if (invStack && this.bot.equip) {
      this.info(`Water drain pickup open: equipping ${invStack.name} before opening dispenser.`);
      await this.bot.equip(invStack, 'hand').catch((error) => {
        this.warn(`Water drain pickup open equip failed: ${error.message}`);
      });
      await this.sleepWaterAnchored(150);
      return;
    }
    this.info(`Water drain pickup open: no non-bucket hotbar item found; held=${this.bot.heldItem?.name || 'none'}.`);
  }

  async discardWaterBucket(reason = 'blocked') {
    const waterBucket = this.inventoryBucket(false);
    if (!waterBucket) return false;
    const key = this.waterDrainCurrent?.source ? posKey(this.waterDrainCurrent.source) : 'unknown';
    this.warn(`Water drain ${reason} at ${key}; tossing water_bucket so next source can continue.`);
    await this.bot.tossStack?.(waterBucket);
    await this.sleepWaterAnchored(this.settings.waterDrainActionDelayMs ?? 500);
    return true;
  }

  async discardWaterBucketIfStoreBlocked() {
    if (!await this.discardWaterBucket('store blocked')) return false;
    this.waterDrainCurrent = null;
    this.state = 'AwaitAreaClear';
    this.timeoutTicks = ticksFromMs(this.settings.waterDrainActionDelayMs ?? 500);
    return true;
  }

  async handleWaterStoreOpenFailure() {
    this.lastInteractedBlockPos = null;
    this.lastInteractRecoveryCheckpoint = null;
    this.interactRetryCount = 0;
    this.interactRecoveryCycleCount = 0;
    this.interactTimeoutTicks = 0;
    if (await this.discardWaterBucketIfStoreBlocked()) return true;
    this.waterDrainCurrent = null;
    this.state = 'AwaitAreaClear';
    this.timeoutTicks = ticksFromMs(this.settings.waterDrainActionDelayMs ?? 500);
    return true;
  }

  async tickWaterBucketMakeRoom() {
    const current = this.waterDrainCurrent;
    if (!current) {
      this.state = 'AwaitAreaClear';
      return;
    }
    const dump = this.randomCarpetStack();
    if (!dump) {
      this.warn(`Water drain blocked: no free inventory slot and no carpet stack to toss at ${posKey(current.source)}.`);
      this.state = 'WaterDrainBlocked';
      return;
    }
    this.stopMovement();
    this.zeroVelocityForResetWater();
    this.info(`Water drain toss carpet ${dump.name} (${dump.count}) to make room for bucket.`);
    await this.bot.tossStack?.(dump);
    this.waterDrainMakeRoom = false;
    this.timeoutTicks = ticksFromMs(this.settings.waterDrainActionDelayMs ?? 500);
    this.checkpoints.unshift({
      goal: this.waterDrainPickupGoal(current.source),
      action: 'waterBucketPickup',
      target: clonePos(current.source),
      dispenser: clonePos(current.dispenser),
      access: current.access || 'top',
      bucketReady: false
    });
    this.state = 'Walking';
  }

  mapAreaClearStatus() {
    let unknown = 0;
    for (let x = 0; x < this.map.width; x += 1) {
      for (let z = 0; z < this.map.depth; z += 1) {
        const pos = this.absolutePos(x, z);
        const block = this.blockAt(pos);
        if (!block) {
          unknown += 1;
          continue;
        }
        if (!this.isOpenBlock(block)) {
          return { clear: false, blocker: { pos, name: block.name }, unknown };
        }
      }
    }
    return { clear: unknown === 0, blocker: null, unknown };
  }

  isMapAreaClear() {
    return this.mapAreaClearStatus().clear;
  }

  isWaterSourceBlock(block) {
    if (block?.name !== 'water') return false;
    const props = typeof block.getProperties === 'function' ? block.getProperties() : block.properties;
    const level = props?.level ?? props?.Level ?? block.metadata;
    if (level === undefined || level === null) {
      const key = block.position ? posKey(block.position) : 'unknown';
      if (!this.unknownWaterSourceLogs.has(key)) {
        this.unknownWaterSourceLogs.add(key);
        this.info(`Water at ${key} has no source level metadata; treating as flow, not drain source.`);
      }
      return false;
    }
    const numeric = Number(level);
    return Number.isFinite(numeric) ? numeric === 0 : String(level) === '0';
  }

  findDrainableWaterSources(limit = Number.POSITIVE_INFINITY, options = {}) {
    const sources = [];
    for (let x = 0; x < this.map.width; x += 1) {
      for (let z = 0; z < this.map.depth; z += 1) {
        const pos = this.absolutePos(x, z);
        const block = this.blockAt(pos);
        if (!this.isWaterSourceBlock(block)) continue;
        if (!options.includeMissingBuckets && this.waterMissingBucketSources.has(posKey(pos))) continue;
        const dispenser = { x: pos.x, y: pos.y - 1, z: pos.z };
        const below = this.blockAt(dispenser);
        if (below?.name !== 'dispenser') continue;
        const under = { x: dispenser.x, y: dispenser.y - 1, z: dispenser.z };
        const access = this.isOpenBlock(this.blockAt(under)) ? 'under' : 'top';
        sources.push({ pos, dispenser, access });
        if (sources.length >= limit) return sources;
      }
    }
    return sources;
  }

  queueWaterDrain(source) {
    const key = posKey(source.pos);
    const attempts = (this.waterDrainAttempts.get(key) || 0) + 1;
    this.waterDrainAttempts.set(key, attempts);
    this.info(`Draining stuck reset water at ${key} using dispenser ${posKey(source.dispenser)} access=${source.access || 'top'}.`);
    this.waterDrainCurrent = {
      source: clonePos(source.pos),
      dispenser: clonePos(source.dispenser),
      access: source.access || 'top',
      bucketReady: false
    };
    this.checkpoints.unshift({
      goal: this.waterDrainPickupGoal(source.pos),
      action: 'waterBucketPickup',
      target: clonePos(source.pos),
      dispenser: clonePos(source.dispenser),
      access: source.access || 'top',
      bucketReady: false
    });
    this.state = 'Walking';
    return true;
  }

  queueWaterBucketReturn() {
    if (!this.waterDrainCurrent || !this.inventoryBucket(false)) return false;
    this.warn(`Water bucket still carried for ${posKey(this.waterDrainCurrent.source)}; returning it before more checks.`);
    this.checkpoints.unshift({
      goal: this.waterDrainPickupGoal(this.waterDrainCurrent.source),
      action: 'waterBucketStore',
      target: clonePos(this.waterDrainCurrent.source),
      dispenser: clonePos(this.waterDrainCurrent.dispenser),
      access: this.waterDrainCurrent.access || 'top'
    });
    this.state = 'Walking';
    return true;
  }

  queueVisibleWaterDrainIfNeeded() {
    if (!this.settings.drainResetWater) return false;
    if (this.isResetWaterState()) return false;
    if (!['Walking', 'Idle'].includes(this.state)) return false;
    if (this.checkpoints.some((checkpoint) => ['reset', 'awaitClear'].includes(checkpoint.action))) {
      return false;
    }
    if (this.checkpoints.some((checkpoint) => ['waterBucketPickup', 'waterBucketStore', 'waterBucketMakeRoom'].includes(checkpoint.action))) {
      return false;
    }
    if (this.queueWaterBucketReturn()) return true;
    const drainableWater = this.findDrainableWaterSources(1);
    if (drainableWater.length === 0) return false;
    this.captureWaterResumeState('visible water interrupt');
    this.warn(`Visible water found while ${this.state}; interrupting to drain.`);
    this.checkpoints = [];
    return this.queueWaterDrain(drainableWater[0]);
  }

  waterDrainInteractGoal(sourcePos, access = 'top') {
    return centerOf(sourcePos);
  }

  waterDrainPickupGoal(sourcePos) {
    const offsets = [
      { x: 0, z: 1 },
      { x: 1, z: 0 },
      { x: 0, z: -1 },
      { x: -1, z: 0 }
    ];
    for (const offset of offsets) {
      const pos = { x: sourcePos.x + offset.x, y: sourcePos.y, z: sourcePos.z + offset.z };
      const block = this.blockAt(pos);
      if (!block || this.isOpenBlock(block)) return centerOf(pos);
    }
    return centerOf({ x: sourcePos.x, y: sourcePos.y, z: sourcePos.z + 1 });
  }

  waterDrainOpenGoals(sourcePos) {
    const positions = [
      { x: sourcePos.x, y: sourcePos.y, z: sourcePos.z + 1 },
      { x: sourcePos.x + 1, y: sourcePos.y, z: sourcePos.z },
      { x: sourcePos.x, y: sourcePos.y, z: sourcePos.z - 1 },
      { x: sourcePos.x - 1, y: sourcePos.y, z: sourcePos.z },
      { x: sourcePos.x, y: sourcePos.y - 1, z: sourcePos.z },
      { x: sourcePos.x, y: sourcePos.y - 2, z: sourcePos.z },
      { x: sourcePos.x, y: sourcePos.y, z: sourcePos.z }
    ];
    const goals = [];
    for (const pos of positions) {
      if (pos.x === sourcePos.x && pos.z === sourcePos.z) {
        goals.push(centerOf(pos));
        continue;
      }
      const block = this.blockAt(pos);
      if (!block || this.isOpenBlock(block)) goals.push(centerOf(pos));
    }
    return goals.length > 0 ? goals : [this.waterDrainPickupGoal(sourcePos)];
  }

  snapToWaterDrainOpenGoal(sourcePos, index = 0) {
    const entity = this.bot.entity;
    if (!entity?.position) return false;
    const goals = this.waterDrainOpenGoals(sourcePos);
    const target = goals[index % goals.length];
    if (distance3d(entity.position, target) > Math.max(16, this.settings.placeRange ?? 5)) return false;
    entity.position = target;
    entity.velocity = new Vec3(0, 0, 0);
    entity.onGround = true;
    if (this.bot._client?.write) {
      this.bot._client.write('position_look', {
        x: target.x,
        y: target.y,
        z: target.z,
        yaw: Math.fround(toNotchianYawRadians(entity.yaw || 0)),
        pitch: Math.fround(toNotchianPitchRadians(entity.pitch || 0)),
        onGround: true,
        flags: { onGround: true, hasHorizontalCollision: false }
      });
    }
    return true;
  }

  snapToWaterDrainSource(sourcePos, access = 'top') {
    const entity = this.bot.entity;
    if (!entity?.position) return false;
    const target = this.waterDrainInteractGoal(sourcePos, access);
    target.y = sourcePos.y;
    if (distance3d(entity.position, target) > Math.max(12, this.settings.placeRange ?? 5)) return false;
    entity.position = target;
    entity.velocity = new Vec3(0, 0, 0);
    entity.onGround = true;
    if (this.bot._client?.write) {
      this.bot._client.write('position_look', {
        x: target.x,
        y: target.y,
        z: target.z,
        yaw: Math.fround(toNotchianYawRadians(entity.yaw || 0)),
        pitch: Math.fround(toNotchianPitchRadians(entity.pitch || 0)),
        onGround: true,
        flags: { onGround: true, hasHorizontalCollision: false }
      });
    }
    return true;
  }

  snapToWaterDrainUnder(sourcePos) {
    const entity = this.bot.entity;
    if (!entity?.position) return false;
    const target = centerOf({ x: sourcePos.x, y: sourcePos.y - 1, z: sourcePos.z });
    if (distance3d(entity.position, target) > Math.max(12, this.settings.placeRange ?? 5)) return false;
    entity.position = target;
    entity.velocity = new Vec3(0, 0, 0);
    entity.onGround = true;
    if (this.bot._client?.write) {
      this.bot._client.write('position_look', {
        x: target.x,
        y: target.y,
        z: target.z,
        yaw: Math.fround(toNotchianYawRadians(entity.yaw || 0)),
        pitch: Math.fround(toNotchianPitchRadians(entity.pitch || 0)),
        onGround: true,
        flags: { onGround: true, hasHorizontalCollision: false }
      });
    }
    return true;
  }

  snapToWaterDrainPickupGoal(sourcePos) {
    const entity = this.bot.entity;
    if (!entity?.position) return false;
    const target = this.waterDrainPickupGoal(sourcePos);
    target.y = sourcePos.y;
    if (distance3d(entity.position, target) > Math.max(12, this.settings.placeRange ?? 5)) return false;
    entity.position = target;
    entity.velocity = new Vec3(0, 0, 0);
    entity.onGround = true;
    if (this.bot._client?.write) {
      this.bot._client.write('position_look', {
        x: target.x,
        y: target.y,
        z: target.z,
        yaw: Math.fround(toNotchianYawRadians(entity.yaw || 0)),
        pitch: Math.fround(toNotchianPitchRadians(entity.pitch || 0)),
        onGround: true,
        flags: { onGround: true, hasHorizontalCollision: false }
      });
    }
    return true;
  }

  async tickAwaitNBTFile() {
    this.mapFile = null;
    if (await this.prepareNextMapFile()) {
      this.optimisticPlacements.clear();
      this.pendingPlacements.clear();
      this.abandonedPlacements.clear();
      this.startBuilding();
    }
  }

  allowedPlacements() {
    const now = Date.now();
    const delay = Math.max(1, this.settings.placeDelayMs ?? TICK_MS);
    const allowedRaw = Math.floor((now - this.lastPlacementTime) / delay);
    if (allowedRaw <= 0) return 0;

    const maxPerTick = Math.max(1, Math.floor(this.settings.maxPlacementsPerTick ?? 4));
    const allowed = Math.min(allowedRaw, maxPerTick);
    if (allowedRaw > maxPerTick) {
      this.lastPlacementTime = now;
    } else {
      this.lastPlacementTime += allowed * delay;
    }
    return allowed;
  }

  async swapIntoHotbar(slot) {
    if (this.bot.currentWindow) {
      this.info(`Closing open window before hotbar swap (${this.bot.currentWindow.type || this.bot.currentWindow.id})`);
      this.closeCurrentWindow();
      this.closeNextWindow = false;
      await sleep(TICK_MS);
    }

    const sourceStack = this.stackInJavaSlot(slot);
    const sourceWindowSlot = sourceStack?.slot ?? this.javaSlotToWindowSlot(slot);
    const frequency = new Map();
    const itemSlot = new Map();
    let targetSlot = this.availableHotBarSlots[0];

    for (const hotbarSlot of this.availableHotBarSlots) {
      const stack = this.stackInJavaSlot(hotbarSlot);
      if (!stack) continue;
      frequency.set(stack.name, (frequency.get(stack.name) || 0) + 1);
      if (!itemSlot.has(stack.name)) itemSlot.set(stack.name, hotbarSlot);
    }

    let topFrequency = 0;
    let topItems = [];
    for (const [itemName, count] of frequency.entries()) {
      if (count > topFrequency) {
        topFrequency = count;
        topItems = [itemName];
      } else if (count === topFrequency) {
        topItems.push(itemName);
      }
    }
    if (topItems.length > 0) targetSlot = itemSlot.get(topItems[Math.floor(Math.random() * topItems.length)]);

    for (const hotbarSlot of this.availableHotBarSlots) {
      if (!this.stackInJavaSlot(hotbarSlot)) targetSlot = hotbarSlot;
    }

    this.bot.setQuickBarSlot?.(targetSlot);
    this.info(`Swapping inventory slot ${slot} (${sourceStack?.name || 'empty'} @ window ${sourceWindowSlot}) into hotbar slot ${targetSlot}`);
    await this.clickWindow(sourceWindowSlot, targetSlot, 2);
    if (sourceStack) await this.waitForHotbarItem(targetSlot, sourceStack.name);
    else await sleep(TICK_MS);

    const targetStack = this.stackInJavaSlot(targetSlot);
    const sourceAfter = this.stackInJavaSlot(slot);
    this.info(
      `Swap result hotbar${targetSlot}=${targetStack?.name || 'empty'}:${targetStack?.count || 0} ` +
      `source${slot}=${sourceAfter?.name || 'empty'}:${sourceAfter?.count || 0}`
    );

    if (sourceStack && targetStack?.name !== sourceStack.name && this.bot.equip) {
      this.warn(`Swap did not put ${sourceStack.name} in hotbar; using Mineflayer equip fallback.`);
      await this.bot.equip(sourceStack, 'hand');
      await this.waitForHotbarItem(targetSlot, sourceStack.name);
    }
    return targetSlot;
  }

  async quickMoveRestockSlot(slot) {
    if (this.settings.debugPrints) this.info(`Quick-moving restock chest slot ${slot}`);
    await this.clickWindow(slot, 1, 1);
  }

  isSealedPrintStrategy() {
    return (this.settings.printStrategy || 'sealed') === 'sealed';
  }

  printAxisAndDirection(goal) {
    const botPos = this.bot.entity.position;
    const dx = goal.x - botPos.x;
    const dz = goal.z - botPos.z;
    const axis = Math.abs(dz) >= Math.abs(dx) ? 'z' : 'x';
    const delta = axis === 'z' ? dz : dx;
    return { axis, direction: Math.sign(delta) || 1 };
  }

  printRunBounds(goal) {
    const goalRelX = Math.floor(goal.x) - this.mapCorner().x;
    return {
      minX: Math.max(0, goalRelX - 1),
      maxX: Math.min(this.map.width - 1, goalRelX + this.settings.linesPerRun - 1)
    };
  }

  plannedMaterialAt(pos) {
    if (!this.isWithinMap(pos)) return null;
    const rel = this.relativePos(pos);
    return this.map.cells[rel.x]?.[rel.z] || null;
  }

  isInPrintRunWindow(pos, goal) {
    if (!this.isWithinMap(pos)) return false;
    const rel = this.relativePos(pos);
    const bounds = this.printRunBounds(goal);
    return rel.x >= bounds.minX && rel.x <= bounds.maxX;
  }

  sealMetrics(pos, goal) {
    const botPos = this.bot.entity.position;
    const centerX = pos.x + 0.5;
    const centerY = pos.y + 0.5;
    const centerZ = pos.z + 0.5;
    const distance = distanceToCenter(botPos, pos);
    const { axis, direction } = this.printAxisAndDirection(goal);
    const centerAxis = axis === 'x' ? centerX : centerZ;
    const progress = (centerAxis - botPos[axis]) * direction;
    const lookbehind = Math.max(0, this.settings.sealLookbehindBlocks ?? 0.75);
    const edgeStart = Math.max(0, (this.settings.placeRange ?? 5) - (this.settings.sealEdgeMargin ?? 0.35));
    const behindBy = Math.max(0, -progress - lookbehind);
    const movingAway = progress <= lookbehind;
    const edgePressure = movingAway ? Math.max(0, distance - edgeStart) : 0;
    const outOfRange = distance > (this.settings.placeRange ?? 5);
    return {
      axis,
      direction,
      distance,
      progress,
      behindBy,
      edgePressure,
      outOfRange,
      urgent: behindBy > 0 || edgePressure > 0
    };
  }

  scanPrintCandidates(goal, alreadyPicked = new Set(), options = {}) {
    this.pruneOptimisticPlacements();
    const botPos = this.bot.entity.position;
    const grounded = {
      x: Math.floor(botPos.x),
      y: this.mapCorner().y,
      z: Math.floor(botPos.z)
    };
    const corner = this.mapCorner();
    const bounds = this.printRunBounds(goal);
    const range = this.settings.placeRange ?? 5;
    const backtrack = Math.max(0, this.settings.sealMaxBacktrackBlocks ?? 3);
    const distanceLimit = options.fullStrip
      ? Number.POSITIVE_INFINITY
      : range + (options.includeOutOfRange ? backtrack : 0);
    const minDistance = options.allowTooClose ? 0 : (this.settings.minPlaceDistance ?? 0.8);
    const hasAbandoned = this.abandonedPlacements.size > 0;
    const checkOptimistic = !options.ignoreOptimistic && this.optimisticPlacements.size > 0;
    const now = Date.now();
    const scanKey = [
      grounded.x,
      grounded.z,
      goal.x.toFixed(3),
      goal.z.toFixed(3),
      options.fullStrip ? 1 : 0,
      options.includeOutOfRange ? 1 : 0,
      options.allowTooClose ? 1 : 0,
      options.ignoreOptimistic ? 1 : 0
    ].join(':');
    let candidates = this.tickScanCache?.get(scanKey);
    if (candidates) {
      return alreadyPicked.size > 0
        ? candidates.filter((candidate) => !alreadyPicked.has(posKey(candidate.pos)))
        : candidates;
    }

    candidates = [];

    const visit = (x, z) => {
      const relX = x - corner.x;
      const relZ = z - corner.z;
      if (relX < bounds.minX || relX > bounds.maxX || relZ < 0 || relZ >= this.map.depth) return;
      const material = this.map.cells[relX]?.[relZ];
      if (!material) return;
      const pos = { x, y: grounded.y, z };
      let key = null;
      if (hasAbandoned) {
        key = posKey(pos);
        const abandonedUntil = this.abandonedPlacements.get(key);
        if (abandonedUntil) {
          if (abandonedUntil <= now) this.abandonedPlacements.delete(key);
          else return;
        }
      }
      const metrics = this.sealMetrics(pos, goal);
      if (metrics.distance > distanceLimit || metrics.distance <= minDistance) return;
      if (!this.isOpenAtCached(pos)) return;
      if (checkOptimistic) {
        key ||= posKey(pos);
        if (this.optimisticPlacements.has(key)) return;
      }
      candidates.push({ pos, material, metrics });
    };

    if (options.fullStrip) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        for (let z = 0; z < this.map.depth; z += 1) {
          visit(this.mapCorner().x + x, this.mapCorner().z + z);
        }
      }
      this.tickScanCache?.set(scanKey, candidates);
      return alreadyPicked.size > 0
        ? candidates.filter((candidate) => !alreadyPicked.has(posKey(candidate.pos)))
        : candidates;
    }

    const radius = Math.ceil(range + (options.includeOutOfRange ? backtrack : 0)) + 1;
    const minX = Math.max(corner.x + bounds.minX, grounded.x - radius);
    const maxX = Math.min(corner.x + bounds.maxX, grounded.x + radius);
    for (let x = minX; x <= maxX; x += 1) {
      for (let z = grounded.z - radius; z <= grounded.z + radius; z += 1) {
        visit(x, z);
      }
    }
    this.tickScanCache?.set(scanKey, candidates);
    return alreadyPicked.size > 0
      ? candidates.filter((candidate) => !alreadyPicked.has(posKey(candidate.pos)))
      : candidates;
  }

  bestCandidateFromList(candidates, options = {}) {
    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const alreadyPicked = options.alreadyPicked;
    for (const candidate of candidates) {
      if (alreadyPicked?.size && alreadyPicked.has(posKey(candidate.pos))) continue;
      const metrics = candidate.metrics;
      if (options.urgentOnly && !metrics.urgent) continue;
      const score =
        (metrics.outOfRange ? 100000 : 0) +
        metrics.edgePressure * 10000 +
        metrics.behindBy * 1000 +
        metrics.distance;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  bestSealCandidate(goal, alreadyPicked = new Set(), options = {}) {
    const candidates = this.scanPrintCandidates(goal, new Set(), {
      ignoreOptimistic: true,
      ...options
    });
    return this.bestCandidateFromList(candidates, { ...options, alreadyPicked });
  }

  findSealedPlacement(goal, alreadyPicked) {
    const candidates = this.scanPrintCandidates(goal, new Set(), {
      ignoreOptimistic: true,
      includeOutOfRange: false
    });
    const urgent = this.bestCandidateFromList(candidates, {
      urgentOnly: true,
      alreadyPicked
    });
    if (urgent) return clonePos(urgent.pos);

    const retryPlacement = this.findPendingPlacement(goal, alreadyPicked);
    if (retryPlacement) return retryPlacement;

    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const key = posKey(candidate.pos);
      if (alreadyPicked?.size && alreadyPicked.has(key)) continue;
      if (this.optimisticPlacements.has(key)) continue;
      if (candidate.metrics.distance < bestDistance) {
        best = candidate.pos;
        bestDistance = candidate.metrics.distance;
      }
    }
    return best ? clonePos(best) : null;
  }

  findSealHoldCandidate(goal, options = {}) {
    return this.bestSealCandidate(goal, new Set(), {
      urgentOnly: true,
      includeOutOfRange: true,
      allowTooClose: true,
      ...options
    });
  }

  lineSealKey(goal) {
    const bounds = this.printRunBounds(goal);
    return `${bounds.minX}:${bounds.maxX}:${goal.x.toFixed(3)}:${goal.z.toFixed(3)}`;
  }

  bestSealCandidateFromKeys(goal, keys, options = {}) {
    const candidates = [];
    for (const value of keys) {
      const pos = typeof value === 'string'
        ? (() => {
            const [x, y, z] = value.split(',').map(Number);
            return { x, y, z };
          })()
        : value;
      if (!this.isInPrintRunWindow(pos, goal)) continue;
      const material = this.plannedMaterialAt(pos);
      if (!material) continue;
      if (!this.isOpenAtCached(pos)) continue;
      const metrics = this.sealMetrics(pos, goal);
      candidates.push({ pos, material, metrics });
    }
    return {
      candidate: this.bestCandidateFromList(candidates, options),
      openKeys: candidates.map((candidate) => clonePos(candidate.pos))
    };
  }

  findUnsealedStripCell(goal) {
    const cacheKey = this.lineSealKey(goal);
    const options = {
      fullStrip: true,
      includeOutOfRange: true,
      allowTooClose: true,
      urgentOnly: false
    };
    if (this.lineSealCacheKey === cacheKey && this.lineSealOpenKeys) {
      const cached = this.bestSealCandidateFromKeys(goal, this.lineSealOpenKeys, options);
      this.lineSealOpenKeys = cached.openKeys;
      if (cached.candidate) return cached.candidate;
    }

    const candidate = this.bestSealCandidate(goal, new Set(), options);
    if (!candidate) {
      this.lineSealCacheKey = null;
      this.lineSealOpenKeys = null;
      return null;
    }

    const candidates = this.scanPrintCandidates(goal, new Set(), {
      ignoreOptimistic: true,
      ...options
    });
    this.lineSealCacheKey = cacheKey;
    this.lineSealOpenKeys = candidates.map((entry) => clonePos(entry.pos));
    return candidate;
  }

  shouldHoldCheckpointForSeal(checkpoint) {
    if (!this.isSealedPrintStrategy()) return null;
    if (checkpoint.action !== 'lineEnd') return null;
    const candidate = this.findUnsealedStripCell(checkpoint.goal);
    if (!candidate) return null;
    const minPlaceDistance = Math.max(0, this.settings.minPlaceDistance ?? 0.8);
    if (candidate.metrics.distance <= (minPlaceDistance + 0.05)) return null;
    return candidate;
  }

  steerForSealHold(candidate, checkpoint) {
    if (!candidate) {
      this.steerToward(checkpoint.goal, checkpoint.action, false);
      return;
    }
    const minPlaceDistance = Math.max(0, this.settings.minPlaceDistance ?? 0.8);
    if (candidate.metrics.distance <= (minPlaceDistance + 0.05)) {
      const center = centerOf(candidate.pos);
      const botPos = this.bot.entity.position;
      const retreat = Math.max(0.35, minPlaceDistance + 0.35);
      let dx = botPos.x - center.x;
      let dz = botPos.z - center.z;
      const length = Math.hypot(dx, dz);
      if (length > 0.05) {
        dx /= length;
        dz /= length;
      } else if (Math.abs(checkpoint.goal.x - center.x) >= Math.abs(checkpoint.goal.z - center.z)) {
        dx = center.x <= checkpoint.goal.x ? -1 : 1;
        dz = 0;
      } else {
        dx = 0;
        dz = center.z <= checkpoint.goal.z ? -1 : 1;
      }
      const target = {
        x: center.x + dx * retreat,
        y: center.y,
        z: center.z + dz * retreat
      };
      this.steerToward(target, checkpoint.action, false);
      return;
    }
    const range = this.settings.placeRange ?? 5;
    if (candidate.metrics.distance > range) {
      const target = centerOf(candidate.pos);
      this.steerToward({ x: target.x, y: target.y, z: target.z }, checkpoint.action, false);
      return;
    }
    this.stopMovement();
  }

  sealNeedsMovementHold(candidate) {
    if (!candidate) return false;
    const minPlaceDistance = Math.max(0, this.settings.minPlaceDistance ?? 0.8);
    if (candidate.metrics.distance <= (minPlaceDistance + 0.05)) return true;
    const threshold = Math.max(0, this.settings.sealMovementHoldBehind ?? 0.35);
    return candidate.metrics.behindBy > threshold;
  }

  logSealHold(candidate, checkpoint) {
    if (!candidate) return;
    const interval = this.settings.sealLogMs ?? 2000;
    if (interval <= 0) return;
    const now = Date.now();
    if (now - this.lastSealHoldLogAt < interval) return;
    this.lastSealHoldLogAt = now;
    const metrics = candidate.metrics;
    this.info(
      `Seal hold ${posKey(candidate.pos)} action=${checkpoint.action || 'line'} ` +
      `d=${metrics.distance.toFixed(2)} behind=${metrics.behindBy.toFixed(2)} ` +
      `edge=${metrics.edgePressure.toFixed(2)} out=${metrics.outOfRange ? 'yes' : 'no'}`
    );
  }

  findClosestPlacement(goal, alreadyPicked) {
    const retryPlacement = this.findPendingPlacement(goal, alreadyPicked);
    if (retryPlacement) return retryPlacement;

    return this.findBestOpenPlacement(goal, alreadyPicked, 'closest');
  }

  findBestOpenPlacement(goal, alreadyPicked, mode = 'closest') {
    let best = null;
    let bestDistance = mode === 'edge' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    const edgeDistance = this.settings.placeRange - (this.settings.backfillEdgeBuffer ?? 1);
    const candidates = this.scanPrintCandidates(goal, new Set(), {
      ignoreOptimistic: false,
      includeOutOfRange: false
    });

    for (const candidate of candidates) {
      if (alreadyPicked.size > 0 && alreadyPicked.has(posKey(candidate.pos))) continue;
      const distance = candidate.metrics.distance;
      if (mode === 'edge') {
        if (distance >= edgeDistance && distance > bestDistance) {
          best = candidate.pos;
          bestDistance = distance;
        }
      } else if (distance < bestDistance) {
        best = candidate.pos;
        bestDistance = distance;
      }
    }
    return best ? clonePos(best) : null;
  }

  findEdgeOpenPlacement(goal, alreadyPicked) {
    return this.findBestOpenPlacement(goal, alreadyPicked, 'edge');
  }

  findPendingPlacement(goal, alreadyPicked) {
    this.pruneOptimisticPlacements();
    const botPos = this.bot.entity.position;
    const now = Date.now();
    const goalRelX = Math.floor(goal.x) - this.mapCorner().x;
    const maxAttempts = Math.max(1, this.settings.placementRetries || 1);
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [pendingKey, entry] of this.pendingPlacements.entries()) {
      const key = posKey(entry.pos);
      if (alreadyPicked.has(key)) continue;
      if (entry.nextRetryAt > now) continue;
      if (entry.attempts >= maxAttempts && this.shouldAbandonPendingPlacement(entry)) {
        this.abandonPendingPlacement(pendingKey, entry);
        continue;
      }
      if (!this.isWithinMap(entry.pos)) continue;
      const rel = this.relativePos(entry.pos);
      if (rel.x > goalRelX + this.settings.linesPerRun - 1 || rel.x < goalRelX - 1) continue;
      if (!this.isOpenAt(entry.pos)) continue;
      const distance = distanceToCenter(botPos, entry.pos);
      if (distance <= this.settings.placeRange && distance > this.settings.minPlaceDistance && distance < bestDistance) {
        best = clonePos(entry.pos);
        bestDistance = distance;
      }
    }
    return best;
  }

  blockingPendingPlacement(goal) {
    this.pruneOptimisticPlacements();
    const botPos = this.bot.entity.position;
    const goalRelX = Math.floor(goal.x) - this.mapCorner().x;
    const maxAttempts = Math.max(1, this.settings.placementRetries || 1);
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [key, entry] of this.pendingPlacements.entries()) {
      if (entry.attempts >= maxAttempts && this.shouldAbandonPendingPlacement(entry)) {
        this.abandonPendingPlacement(key, entry);
        continue;
      }
      if (!this.isWithinMap(entry.pos)) continue;
      const rel = this.relativePos(entry.pos);
      if (rel.x > goalRelX + this.settings.linesPerRun - 1 || rel.x < goalRelX - 1) continue;
      if (!this.isOpenAt(entry.pos)) continue;
      const distance = distanceToCenter(botPos, entry.pos);
      const closeToLeavingRange = distance >= this.settings.placeRange - (this.settings.pendingHoldEdgeBuffer ?? 0.75);
      if (closeToLeavingRange && distance <= this.settings.placeRange && distance > this.settings.minPlaceDistance && distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
    }
    return best;
  }

  pendingAirBacklogInRange(goal) {
    this.pruneOptimisticPlacements();
    const botPos = this.bot.entity.position;
    const goalRelX = Math.floor(goal.x) - this.mapCorner().x;
    const now = Date.now();
    let count = 0;
    for (const entry of this.pendingPlacements.values()) {
      if (entry.nextRetryAt > now) continue;
      if (!this.isWithinMap(entry.pos)) continue;
      const rel = this.relativePos(entry.pos);
      if (rel.x > goalRelX + this.settings.linesPerRun - 1 || rel.x < goalRelX - 1) continue;
      if (!this.isOpenAt(entry.pos)) continue;
      const distance = distanceToCenter(botPos, entry.pos);
      if (distance <= this.settings.placeRange && distance > this.settings.minPlaceDistance) count += 1;
    }
    return count;
  }

  hotbarSlotWith(material) {
    if (this.bot.heldItem?.name === material && this.availableHotBarSlots.includes(this.bot.quickBarSlot)) {
      return this.bot.quickBarSlot;
    }
    for (const slot of this.availableHotBarSlots) {
      const stack = this.stackInJavaSlot(slot);
      if (stack?.name === material) return slot;
    }
    return -1;
  }

  inventorySlotWith(material) {
    for (const slot of this.availableSlots) {
      if (this.availableHotBarSlots.includes(slot)) continue;
      const stack = this.stackInJavaSlot(slot);
      if (stack?.name === material) return slot;
    }
    return -1;
  }

  async selectHotbarSlot(slot) {
    const previous = this.bot.quickBarSlot;
    this.bot.setQuickBarSlot?.(slot);
    if (previous !== slot && this.settings.hotbarSettleMs > 0) {
      await sleep(this.settings.hotbarSettleMs);
    }
  }

  async waitForHotbarItem(slot, itemName, timeoutMs = this.settings.hotbarSwapConfirmMs ?? 250) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
      const stack = this.stackInJavaSlot(slot);
      if (stack?.name === itemName) return true;
      await sleep(TICK_MS);
    }
    return this.stackInJavaSlot(slot)?.name === itemName;
  }

  async tryPlacingBlock(pos) {
    const rel = this.relativePos(pos);
    const material = this.map.cells[rel.x]?.[rel.z];
    if (!material) return true;
    if (this.hasMaterialAt(pos, material)) {
      const key = posKey(pos);
      this.pendingPlacements.delete(key);
      this.optimisticPlacements.delete(key);
      return true;
    }

    const hotbarSlot = this.hotbarSlotWith(material);
    if (hotbarSlot !== -1) {
      await this.selectHotbarSlot(hotbarSlot);
      if (material === this.lastSwappedMaterial) this.lastSwappedMaterial = null;
    } else {
      const invSlot = this.inventorySlotWith(material);
      if (invSlot !== -1) {
        this.lastSwappedMaterial = material;
        this.toBeSwappedSlot = invSlot;
        this.stopMovement();
        if (this.bot.entity) this.bot.entity.velocity = new Vec3(0, 0, 0);
        this.timeoutTicks = ticksFromMs(this.settings.preSwapDelayMs);
        return false;
      }
      if (this.lastSwappedMaterial === material) return false;
      this.info(`No ${material} found in inventory. Resetting...`);
      const key = posKey(pos);
      this.optimisticPlacements.delete(key);
      this.pendingPlacements.delete(key);
      this.seedRestockMaterial(material, pos);
      this.checkpoints.unshift(this.restockResumeCheckpoint(this.bot.entity.position));
      this.checkpoints.unshift({ goal: this.carpetConfig.dumpStation.pos, action: 'dump' });
      return false;
    }

    const placementReference = this.getPlacementReference(pos);
    if (!placementReference) return true;
    if (placementReference.mode === 'side') this.placementReferenceStats.side += 1;
    if (placementReference.mode === 'below') this.placementReferenceStats.below += 1;

    try {
      const pendingAttempts = this.pendingPlacements.get(posKey(pos))?.attempts || 0;
      const careful = pendingAttempts >= (this.settings.placementCarefulAfterAttempts ?? 8);
      const sent = await this.placeOnReference(placementReference.reference, pos, {
        careful,
        referencePos: placementReference.referencePos,
        faceVector: placementReference.faceVector
      });
      this.sentPlacements += sent;
      if (placementReference.mode === 'below' && placementReference.clickable) {
        this.placementReferenceStats.clickableBelow += 1;
      }
      if (Math.floor((this.sentPlacements - sent) / 256) !== Math.floor(this.sentPlacements / 256)) {
        this.info(`Placed packets sent: ${this.sentPlacements}`);
      }
      this.trackPendingPlacement(pos, material);
      return true;
    } catch (error) {
      this.warn(`Place send failed at ${posKey(pos)} (${material}): ${error.message}`);
      this.trackPendingPlacement(pos, material, true);
      return true;
    }
  }

  trackPendingPlacement(pos, material, retrySoon = false) {
    const key = posKey(pos);
    if (this.isAbandonedPlacement(pos)) return;
    const previous = this.pendingPlacements.get(key);
    const maxAttempts = Math.max(1, this.settings.placementRetries || 1);
    if ((previous?.attempts || 0) >= maxAttempts && this.shouldAbandonPendingPlacement(previous)) {
      this.abandonPendingPlacement(key, previous);
      return;
    }
    const attempts = Math.min((previous?.attempts || 0) + 1, maxAttempts);
    const retryDelay = retrySoon ? TICK_MS : Math.max(TICK_MS, this.settings.placementRetryDelayMs || 150);
    this.pendingPlacements.set(key, {
      pos: clonePos(pos),
      material,
      attempts,
      nextRetryAt: Date.now() + retryDelay
    });
    this.optimisticPlacements.set(key, {
      material,
      expiresAt: Date.now() + Math.max(retryDelay, this.settings.placementPendingMs || 1500)
    });
  }

  isAbandonedPlacement(pos) {
    const key = posKey(pos);
    const expiresAt = this.abandonedPlacements.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.abandonedPlacements.delete(key);
      return false;
    }
    return true;
  }

  shouldAbandonPendingPlacement(entry) {
    if (!entry?.pos) return true;
    const block = this.blockAt(entry.pos);
    return Boolean(block && !this.isOpenBlock(block));
  }

  abandonPendingPlacement(key, entry) {
    this.pendingPlacements.delete(key);
    this.optimisticPlacements.delete(key);
    this.abandonedPlacements.set(key, Date.now() + Math.max(TICK_MS, this.settings.placementAbandonMs || 30000));
    if (entry) this.warn(`Skipping stubborn placement ${key} (${entry.material}) after ${entry.attempts} tries.`);
  }

  async placeOnReference(reference, pos, options = {}) {
    const location = reference.position || toVec3(options.referencePos || { x: pos.x, y: pos.y - 1, z: pos.z });
    const faceVector = options.faceVector || new Vec3(0, 1, 0);
    if (this.settings.packetPlaceLook || options.careful) {
      await this.bot.lookAt?.(location.offset(0.5 + faceVector.x * 0.5, 0.5 + faceVector.y * 0.5, 0.5 + faceVector.z * 0.5), true);
    }
    let sent = 0;
    const burst = Math.max(1, Math.floor(this.settings.placementBurst || 1));
    const usePacketPlace = Boolean(this.bot._client?.write && this.bot.supportFeature);
    const shouldSneak = this.shouldSneakForReference(reference);
    const forcePacketSneak = usePacketPlace && shouldSneak && this.settings.packetSneakPlace !== false;
    await this.withSneakPlace(async () => {
      for (let i = 0; i < burst; i += 1) {
        if (usePacketPlace) {
          if (this.sendUseBlockPacket(location, faceVector)) sent += 1;
        } else if (this.bot._genericPlace) {
          await this.bot._genericPlace(reference, faceVector, {
            swingArm: 'right',
            forceLook: 'ignore'
          });
          sent += 1;
        }
      }
    }, shouldSneak, usePacketPlace, { forcePacketSneak });
    if (sent === 0) throw new Error('No placement transport available');
    return sent;
  }

  shouldSneakForReference(reference) {
    const name = reference?.name || '';
    if (INTERACTABLE_SUPPORTS.has(name)) return true;
    if (name.endsWith('_shulker_box')) return true;
    if (name.endsWith('_button') || name.endsWith('_door') || name.endsWith('_trapdoor')) return true;
    return name.endsWith('_fence_gate');
  }

  sendServerSneakPacket(state) {
    if (!this.bot._client?.write || !this.bot.entity) return false;
    if (this.bot.supportFeature?.('newPlayerInputPacket')) {
      this.bot._client.write('player_input', {
        inputs: {
          shift: state
        }
      });
    } else {
      this.bot._client.write('entity_action', {
        entityId: this.bot.entity.id,
        actionId: this.bot.supportFeature?.('entityActionUsesStringMapper')
          ? (state ? 'start_sneaking' : 'stop_sneaking')
          : (state ? 0 : 1),
        jumpBoost: 0
      });
    }
    return true;
  }

  async withSneakPlace(callback, shouldSneak = true, packetOnly = false, options = {}) {
    const canPacketSneak = Boolean(packetOnly && shouldSneak && this.settings.packetSneakPlace && this.bot._client?.write);
    if (canPacketSneak && (options.forcePacketSneak || this.settings.sneakPlace)) {
      this.placementReferenceStats.packetSneak += 1;
      this.sendServerSneakPacket(true);
      try {
        return await callback();
      } finally {
        this.sendServerSneakPacket(false);
      }
    }
    if (!shouldSneak || !this.settings.sneakPlace) {
      return callback();
    }
    if (!this.bot.setControlState) return callback();
    const wasSneaking = this.bot.getControlState?.('sneak') || false;
    this.placementReferenceStats.controlSneak += 1;
    if (!wasSneaking) this.bot.setControlState('sneak', true);
    try {
      return await callback();
    } finally {
      if (!wasSneaking) this.bot.setControlState('sneak', false);
    }
  }

  pruneOptimisticPlacements(force = false) {
    const now = Date.now();
    if (!force) {
      if (this.tickBlockCache && this.lastOptimisticPruneTick === this.tickId) return;
      const interval = Math.max(0, this.settings.placementPruneMs ?? 100);
      if (interval > 0 && now - this.lastOptimisticPruneAt < interval) return;
      this.lastOptimisticPruneAt = now;
      if (this.tickBlockCache) this.lastOptimisticPruneTick = this.tickId;
    }
    for (const [key, entry] of this.optimisticPlacements.entries()) {
      const [x, y, z] = key.split(',').map(Number);
      const pos = { x, y, z };
      const block = force ? this.blockAt(pos) : this.blockAtCached(pos);
      if (block?.name === entry.material) {
        this.optimisticPlacements.delete(key);
        this.pendingPlacements.delete(key);
      } else if (block && !this.isOpenBlock(block)) {
        this.optimisticPlacements.delete(key);
        this.pendingPlacements.delete(key);
      } else if (now >= entry.expiresAt) {
        this.optimisticPlacements.delete(key);
      }
    }
    for (const [key, entry] of this.pendingPlacements.entries()) {
      const block = force ? this.blockAt(entry.pos) : this.blockAtCached(entry.pos);
      if (block?.name === entry.material || (block && !this.isOpenBlock(block))) {
        this.pendingPlacements.delete(key);
        this.optimisticPlacements.delete(key);
      }
    }
    for (const [key, expiresAt] of this.abandonedPlacements.entries()) {
      if (expiresAt <= now) this.abandonedPlacements.delete(key);
    }
  }

  clearOpenOptimisticPlacements() {
    let cleared = 0;
    for (const [key, entry] of this.optimisticPlacements.entries()) {
      const [x, y, z] = key.split(',').map(Number);
      const pos = { x, y, z };
      const block = this.blockAt(pos);
      if (block?.name === entry.material) {
        this.optimisticPlacements.delete(key);
        this.pendingPlacements.delete(key);
      } else if (block && this.isOpenBlock(block)) {
        this.optimisticPlacements.delete(key);
        cleared += 1;
      }
    }
    if (cleared > 0) this.info(`Restock cleared ${cleared} stale optimistic open placements.`);
    this.clearPrintCaches();
    return cleared;
  }

  async handleCheckpoint(checkpoint) {
    if (this.settings.debugPrints && checkpoint.action) this.info(`Reached ${checkpoint.action}`);
    switch (checkpoint.action) {
      case 'lineEnd': {
        const atCornerSide = Math.abs(checkpoint.goal.z - (this.mapCorner().z + 0.5)) < 0.01;
        this.calculateBuildingPath(atCornerSide, false);
        const newErrors = this.getInvalidPlacements();
        const errorLogLimit = this.settings.errorLogLimit ?? 25;
        for (const errorPos of newErrors.slice(0, errorLogLimit)) {
          const rel = this.relativePos(errorPos);
          if (this.settings.logErrors) {
            const expected = this.map.cells[rel.x]?.[rel.z] || 'empty';
            const actual = this.blockAt(errorPos)?.name || 'unknown';
            this.info(`Error at ${posKey(errorPos)}. Is: ${actual}. Should be: ${expected}`);
          }
        }
        if (this.settings.logErrors && newErrors.length > errorLogLimit) {
          this.warn(`Suppressed ${newErrors.length - errorLogLimit} more placement error logs.`);
        }
        this.knownErrors.push(...newErrors);
        const dirtyLimit = this.settings.resetDirtyMapErrorLimit ?? 256;
        if (this.settings.errorAction === 'Repair' && dirtyLimit > 0 && this.knownErrors.length > dirtyLimit) {
          this.warn(`Found ${this.knownErrors.length} wrong carpets, above repair limit ${dirtyLimit}.`);
          this.queueResetForErrors();
        }
        if (this.knownErrors.length > 0 && this.settings.errorAction === 'Reset') {
          this.warn('ErrorAction is Reset: resetting map because of an error...');
          this.queueResetForErrors();
        }
        return true;
      }
      case 'mapMaterialChest': {
        const mapMaterialChest = this.getBestChest(CARTOGRAPHY_TABLE_ITEM);
        this.interactRetryCount = 0;
        this.state = 'AwaitMapChestResponse';
        await this.interactWithBlock(mapMaterialChest.blockPos, {
          recoveryCheckpoint: { goal: mapMaterialChest.openPos, action: 'mapMaterialChest', target: mapMaterialChest.blockPos }
        });
        return false;
      }
      case 'fillMap': {
        this.bot.activateItem?.();
        if (this.settings.mapFillSquareSize === 0) {
          this.checkpoints.unshift({ goal: this.carpetConfig.cartographyTable.openPos, action: 'cartographyTable' });
        } else {
          const size = this.settings.mapFillSquareSize;
          this.checkpoints.push({ goal: { x: checkpoint.goal.x - size, y: checkpoint.goal.y, z: checkpoint.goal.z + size }, action: 'sprint' });
          this.checkpoints.push({ goal: { x: checkpoint.goal.x + size, y: checkpoint.goal.y, z: checkpoint.goal.z + size }, action: 'sprint' });
          this.checkpoints.push({ goal: { x: checkpoint.goal.x + size, y: checkpoint.goal.y, z: checkpoint.goal.z - size }, action: 'sprint' });
          this.checkpoints.push({ goal: { x: checkpoint.goal.x - size, y: checkpoint.goal.y, z: checkpoint.goal.z - size }, action: 'sprint' });
          this.checkpoints.push({ goal: this.carpetConfig.cartographyTable.openPos, action: 'cartographyTable' });
        }
        return false;
      }
      case 'cartographyTable':
        this.interactRetryCount = 0;
        this.state = 'AwaitCartographyResponse';
        await this.interactWithBlock(this.carpetConfig.cartographyTable.blockPos, {
          recoveryCheckpoint: {
            goal: this.carpetConfig.cartographyTable.openPos,
            action: 'cartographyTable',
            target: this.carpetConfig.cartographyTable.blockPos
          }
        });
        return false;
      case 'finishedMapChest':
        this.interactRetryCount = 0;
        this.state = 'AwaitFinishedMapChestResponse';
        await this.interactWithBlock(this.carpetConfig.finishedMapChest.blockPos, {
          recoveryCheckpoint: {
            goal: this.carpetConfig.finishedMapChest.openPos,
            action: 'finishedMapChest',
            target: this.carpetConfig.finishedMapChest.blockPos
          }
        });
        return false;
      case 'reset':
        this.info('Resetting...');
        this.interactRetryCount = 0;
        this.state = 'AwaitResetResponse';
        await this.interactWithBlock(this.carpetConfig.reset.blockPos, {
          recoveryCheckpoint: {
            goal: this.carpetConfig.reset.openPos,
            action: 'reset',
            target: this.carpetConfig.reset.blockPos
          }
        });
        return false;
      case 'waterBucketPickup':
        this.waterDrainCurrent = {
          source: clonePos(checkpoint.target),
          dispenser: clonePos(checkpoint.dispenser || {
            x: checkpoint.target.x,
            y: checkpoint.target.y - 1,
            z: checkpoint.target.z
          }),
          access: checkpoint.access || 'top',
          bucketReady: Boolean(checkpoint.bucketReady)
        };
        if (this.inventoryBucket(false) && !this.inventoryBucket(true)) {
          await this.discardWaterBucket('stale carried bucket before pickup');
        }
        if (this.inventoryBucket(true)) {
          this.info(`Water drain already has empty bucket; skipping dispenser open for ${posKey(this.waterDrainCurrent.source)}.`);
          this.state = 'WaterBucketDrain';
          this.timeoutTicks = ticksFromMs(this.settings.waterDrainActionDelayMs ?? 500);
          return false;
        }
        if (!this.hasFreePlayerInventorySlot()) {
          const dump = this.randomCarpetStack();
          if (!dump) {
            this.warn(`Water drain blocked: no free inventory slot and no carpet stack to toss at ${posKey(this.waterDrainCurrent.source)}.`);
            this.state = 'WaterDrainBlocked';
            return false;
          }
          this.state = 'WaterBucketMakeRoom';
          this.stopMovement();
          await this.tickWaterBucketMakeRoom();
          return false;
        }
        this.interactRetryCount = 0;
        this.state = 'AwaitWaterBucketPickup';
        this.snapToWaterDrainPickupGoal(this.waterDrainCurrent.source);
        await this.selectWaterPickupOpenHand();
        await this.interactWithBlock(this.waterDrainCurrent.dispenser, {
          recoveryCheckpoint: {
            goal: checkpoint.goal,
            action: 'waterBucketPickup',
            target: this.waterDrainCurrent.source,
            dispenser: this.waterDrainCurrent.dispenser,
            access: this.waterDrainCurrent.access,
            bucketReady: false
          },
          preferActivate: true,
          preferContainerOpen: true,
          preferTopFace: this.waterDrainCurrent.access !== 'under',
          preferFaceVector: this.waterDrainCurrent.access === 'under' ? new Vec3(0, -1, 0) : null
        });
        return false;
      case 'waterBucketMakeRoom':
        this.waterDrainCurrent = {
          source: clonePos(checkpoint.target),
          dispenser: clonePos(checkpoint.dispenser || {
            x: checkpoint.target.x,
            y: checkpoint.target.y - 1,
            z: checkpoint.target.z
          }),
          access: checkpoint.access || 'top',
          bucketReady: Boolean(checkpoint.bucketReady)
        };
        this.state = 'WaterBucketMakeRoom';
        this.stopMovement();
        await this.tickWaterBucketMakeRoom();
        return false;
      case 'waterBucketStore':
        this.waterDrainCurrent = {
          source: clonePos(checkpoint.target),
          dispenser: clonePos(checkpoint.dispenser || {
            x: checkpoint.target.x,
            y: checkpoint.target.y - 1,
            z: checkpoint.target.z
          }),
          access: checkpoint.access || 'top'
        };
        this.interactRetryCount = 0;
        this.state = 'AwaitWaterBucketStore';
        this.setWaterDrainSneak(false, 'store open');
        await this.selectWaterDispenserOpenHand('store open');
        this.snapToWaterDrainPickupGoal(this.waterDrainCurrent.source);
        await this.interactWithBlock(this.waterDrainCurrent.dispenser, {
          recoveryCheckpoint: {
            goal: checkpoint.goal,
            action: 'waterBucketStore',
            target: this.waterDrainCurrent.source,
            dispenser: this.waterDrainCurrent.dispenser,
            access: this.waterDrainCurrent.access
          },
          preferActivate: true,
          preferContainerOpen: true,
          preferTopFace: this.waterDrainCurrent.access !== 'under',
          preferFaceVector: this.waterDrainCurrent.access === 'under' ? new Vec3(0, -1, 0) : null
        });
        return false;
      case 'dump':
        this.state = 'Dumping';
        this.stopMovement();
        await this.bot.look?.(
          fromNotchianYawDegrees(this.carpetConfig.dumpStation.yaw),
          fromNotchianPitchDegrees(this.carpetConfig.dumpStation.pitch),
          true
        );
        return false;
      case 'refill':
        this.interactRetryCount = 0;
        this.state = 'AwaitRestockResponse';
        await this.interactWithBlock(checkpoint.target, {
          recoveryCheckpoint: { goal: checkpoint.goal, action: 'refill', target: checkpoint.target }
        });
        return false;
      case 'awaitClear':
        this.state = 'AwaitResetSettle';
        this.timeoutTicks = ticksFromMs(this.settings.resetViewBoostMs ?? 5000);
        this.info(`At map center; waiting ${this.settings.resetViewBoostMs ?? 5000}ms before water check.`);
        this.stopMovement();
        return false;
      case 'break':
        this.state = 'AwaitBlockBreak';
        this.miningPos = checkpoint.target;
        this.stopMovement();
        await this.tickBlockBreak();
        return false;
      default:
        return true;
    }
  }

  async handleFinishedPath() {
    const openCells = this.getOpenPlannedCells(10);
    if (openCells.length > 0) {
      this.warn(`Finish blocked: ${openCells.length}+ open planned cells remain; rebuilding path.`);
      if (this.restartOpenCellsFromWorld()) return;
    }
    if (this.knownErrors.length > 0) {
      if (this.settings.errorAction === 'ToggleOff') {
        throw new Error(`Found ${this.knownErrors.length} placement errors.`);
      }
      if (this.settings.errorAction === 'Repair') {
        this.info(`Fixing errors: ${this.knownErrors.map(posKey).join(', ')}`);
        for (let i = this.knownErrors.length - 1; i >= 0; i -= 1) {
          const errorPos = this.knownErrors[i];
          this.checkpoints.push({ goal: centerOf(errorPos), action: 'break', target: errorPos });
        }
        this.checkpoints.push({ goal: this.carpetConfig.dumpStation.pos, action: 'dump' });
        for (let i = 0; i < this.knownErrors.length; i += 1) {
          const errorPos = this.knownErrors[i];
          this.checkpoints.push({ goal: centerOf(errorPos), action: i === this.knownErrors.length - 1 ? 'lineEnd' : 'sprint' });
        }
        this.knownErrors = [];
        return;
      }
    }
    await this.endBuilding();
  }

  handleInteractTimeoutFallback() {
    const action = this.lastInteractRecoveryCheckpoint?.action;
    if (this.state === 'AwaitResetResponse' || action === 'reset') {
      this.warn('Reset interaction timed out repeatedly; continuing to reset clear wait.');
      this.lastInteractedBlockPos = null;
      this.lastInteractRecoveryCheckpoint = null;
      this.interactRetryCount = 0;
      this.interactRecoveryCycleCount = 0;
      this.beginResetCloseWait();
      return true;
    }

    if (this.state === 'AwaitWaterBucketPickup' || action === 'waterBucketPickup') {
      return this.blockWaterDrainOpenFailure();
    }
    if (this.state === 'AwaitWaterBucketStore' || action === 'waterBucketStore') {
      return this.discardWaterBucketIfStoreBlocked();
    }

    const maxCycles = Math.max(1, this.settings.interactRecoveryCycles ?? 2);
    if (this.interactRecoveryCycleCount < maxCycles) return false;

    if (this.state === 'AwaitFinishedMapChestResponse' || action === 'finishedMapChest') {
      if (!this.hasFilledMapInInventory()) {
        this.warn('Finished map chest timed out, but no filled map remains; continuing to reset.');
        this.lastInteractedBlockPos = null;
        this.lastInteractRecoveryCheckpoint = null;
        this.interactRetryCount = 0;
        this.interactRecoveryCycleCount = 0;
        this.queueResetAfterFinishedMap();
        this.state = 'Walking';
        return true;
      }
      this.warn('Finished map chest still has filled map in inventory; retrying instead of skipping store.');
    }

    return false;
  }

  blockWaterDrainOpenFailure() {
    const current = this.waterDrainCurrent;
    if (!current?.source) return false;
    const key = posKey(current.source);
    const failures = (this.waterDispenserOpenFailures.get(key) || 0) + 1;
    this.waterDispenserOpenFailures.set(key, failures);
    this.warn(`Water drain source ${key} dispenser would not open after ${failures} cycle(s); postponing it and draining other sources first.`);
    this.waterMissingBucketSources.add(key);
    this.lastInteractedBlockPos = null;
    this.lastInteractRecoveryCheckpoint = null;
    this.interactRetryCount = 0;
    this.interactRecoveryCycleCount = 0;
    this.interactTimeoutTicks = 0;
    this.checkpoints = [];
    this.waterDrainCurrent = null;
    this.state = 'AwaitAreaClear';
    return true;
  }

  async tickWalking(allowedPlacements) {
    if (this.checkpoints.length === 0) {
      this.checkpoints.push({ goal: clonePos(this.bot.entity.position), action: 'lineEnd' });
    }

    let checkpoint = this.checkpoints[0];
    let checkpointSealHold = null;
    let reachedCheckpoint = this.checkpointReached(checkpoint);
    if (reachedCheckpoint) {
      checkpointSealHold = this.shouldHoldCheckpointForSeal(checkpoint);
      if (checkpointSealHold) reachedCheckpoint = false;
    }

    if (reachedCheckpoint) {
      this.checkpoints.shift();
      const keepWalking = await this.handleCheckpoint(checkpoint);
      if (!keepWalking || this.state !== 'Walking') return;
      if (this.checkpoints.length === 0) {
        await this.handleFinishedPath();
        if (this.checkpoints.length === 0) return;
      }
      checkpoint = this.checkpoints[0];
    }

    const canPlaceAtCheckpoint = this.isPrintCheckpointAction(checkpoint.action);
    const sealHold = canPlaceAtCheckpoint && this.isSealedPrintStrategy()
      ? (checkpointSealHold || this.findSealHoldCandidate(checkpoint.goal))
      : null;
    const sealMovementHold = this.sealNeedsMovementHold(sealHold);
    if (sealMovementHold) {
      this.logSealHold(sealHold, checkpoint);
      this.steerForSealHold(sealHold, checkpoint);
    }
    else this.steerToward(checkpoint.goal, checkpoint.action, false);
    if (!canPlaceAtCheckpoint) return;

    const placements = new Set();
    const placementLimit = sealHold
      ? Math.max(allowedPlacements, Math.max(1, Math.floor(this.settings.sealUrgentBurst ?? 4)))
      : allowedPlacements;
    for (let i = 0; i < placementLimit; i += 1) {
      const placement = this.isSealedPrintStrategy()
        ? this.findSealedPlacement(checkpoint.goal, placements)
        : this.findClosestPlacement(checkpoint.goal, placements);
      if (!placement) return;
      placements.add(posKey(placement));
      if (!await this.tryPlacingBlock(placement)) return;
    }
  }

  async tick() {
    this.beginTickCaches();
    try {
      await this.tickWithCaches();
    } finally {
      this.endTickCaches();
    }
  }

  async tickWithCaches() {
    this.logStateChange();
    this.logProgress();
    this.zeroVelocityForResetWater();
    const allowedPlacements = this.allowedPlacements();

    if (this.interactTimeoutTicks > 0) {
      this.interactTimeoutTicks -= 1;
      if (this.interactTimeoutTicks === 0 && this.lastInteractedBlockPos) {
        this.interactRetryCount += 1;
        const waterInteractState = this.state === 'AwaitWaterBucketPickup' || this.state === 'AwaitWaterBucketStore';
        const maxRetries = waterInteractState
          ? 1
          : Math.max(1, this.settings.interactRecoveryRetries ?? 4);
        if (this.interactRetryCount >= maxRetries && this.lastInteractRecoveryCheckpoint) {
          this.interactRecoveryCycleCount += 1;
          if (this.handleInteractTimeoutFallback()) return;
          this.warn('Interaction timed out repeatedly; re-walking to interaction point.');
          this.checkpoints.unshift({
            ...this.lastInteractRecoveryCheckpoint,
            goal: clonePos(this.lastInteractRecoveryCheckpoint.goal),
            target: clonePos(this.lastInteractRecoveryCheckpoint.target)
          });
          this.lastInteractedBlockPos = null;
          this.lastInteractRecoveryCheckpoint = null;
          this.interactRetryCount = 0;
          this.state = 'Walking';
          return;
        }
        this.info('Interaction timed out. Interacting again...');
        await this.interactWithBlock(this.lastInteractedBlockPos, {
          preferActivate: this.lastInteractPreferActivate,
          preferContainerOpen: this.lastInteractPreferContainerOpen,
          preferTopFace: this.lastInteractPreferTopFace,
          preferFaceVector: this.lastInteractPreferFaceVector
        });
      }
    }

    if (this.closeResetChestTicks > 0) {
      this.closeResetChestTicks -= 1;
      if (this.closeResetChestTicks === 0) {
        this.queueAwaitClearAfterReset();
      }
    }

    if (this.resetViewRestoreTicks > 0) {
      this.resetViewRestoreTicks -= 1;
      if (this.resetViewRestoreTicks === 0) this.restoreResetViewDistance();
    }

    if (this.timeoutTicks > 0) {
      if (this.state === 'AwaitResetSettle' || this.bot.entity?.onGround !== false) this.timeoutTicks -= 1;
      this.stopMovement();
      if (this.timeoutTicks === 0 && this.state === 'AwaitResetSettle') {
        this.restoreResetViewDistance();
        this.info('Reset settle done; checking water/map clear.');
        this.state = 'AwaitAreaClear';
      }
      return;
    }

    if (this.toBeSwappedSlot !== -1) {
      const slot = this.toBeSwappedSlot;
      this.toBeSwappedSlot = -1;
      await this.swapIntoHotbar(slot);
      if (this.settings.postSwapDelayMs !== 0) {
        this.timeoutTicks = ticksFromMs(this.settings.postSwapDelayMs);
        return;
      }
    }

    if (this.restockBacklogSlots.length > 0) {
      const slot = this.restockBacklogSlots.shift();
      await this.quickMoveRestockSlot(slot);
      if (this.restockBacklogSlots.length === 0) {
        if (this.state === 'AwaitRestockResponse') this.endRestocking();
      } else {
        this.timeoutTicks = ticksFromMs(this.settings.invActionDelayMs);
      }
      return;
    }

    if (this.state === 'AwaitBlockBreak') {
      await this.tickBlockBreak();
      return;
    }

    if (this.queueVisibleWaterDrainIfNeeded()) return;

    if (this.state === 'Dumping') {
      await this.tickDumping();
      return;
    }

    if (this.state === 'AwaitAreaClear') {
      if (this.queueWaterBucketReturn()) return;
      if (this.settings.drainResetWater) {
        const drainableWater = this.findDrainableWaterSources(1);
        if (drainableWater.length > 0) {
          this.queueWaterDrain(drainableWater[0]);
          return;
        }
        const missingBucketWater = this.findDrainableWaterSources(1, { includeMissingBuckets: true });
        if (missingBucketWater.length > 0) {
          const allSkippedWater = this.findDrainableWaterSources(Number.POSITIVE_INFINITY, { includeMissingBuckets: true })
            .filter((source) => this.waterMissingBucketSources.has(posKey(source.pos)));
          const sample = allSkippedWater
            .slice(0, 4)
            .map((source) => posKey(source.pos))
            .join(', ');
          this.warn(
            `Water drain skipped ${allSkippedWater.length || missingBucketWater.length} blocked source(s)` +
            `${sample ? `: ${sample}` : ''}; resuming instead of freezing.`
          );
          if (this.restoreWaterResumeStateIgnoringSkipped('blocked dispenser open')) return;
        }
      }
      const clearStatus = this.mapAreaClearStatus();
      if (clearStatus.clear) {
        this.state = 'AwaitNBTFile';
      } else {
        const now = Date.now();
        if (now - this.lastAreaClearLogAt > (this.settings.progressLogMs ?? 10000)) {
          this.lastAreaClearLogAt = now;
          if (clearStatus.blocker) {
            this.info(
              `Waiting for reset clear: ${clearStatus.blocker.name} at ` +
              `${posKey(clearStatus.blocker.pos)} unknown=${clearStatus.unknown}`
            );
          } else {
            this.info(`Waiting for reset clear: unknown blocks=${clearStatus.unknown}`);
          }
        }
        return;
      }
    }

    if (this.state === 'WaterBucketDrain') {
      await this.tickWaterBucketDrain();
      return;
    }

    if (this.state === 'WaterBucketMakeRoom') {
      await this.tickWaterBucketMakeRoom();
      return;
    }

    if (this.state === 'WaterBucketRecover') {
      await this.tickWaterBucketRecover();
      return;
    }

    if (this.state === 'AwaitNBTFile') {
      await this.tickAwaitNBTFile();
      return;
    }

    if (this.toBeHandledWindow) {
      const window = this.toBeHandledWindow;
      this.toBeHandledWindow = null;
      await this.handleInventoryWindow(window);
      return;
    }

    if (this.closeNextWindow) {
      this.closeCurrentWindow();
      this.closeNextWindow = false;
    }

    if (this.state !== 'Walking') return;
    await this.tickWalking(allowedPlacements);
  }

  async run() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    await this.initialize();
    while (this.running && !this.stopped && this.isConnected()) {
      await this.tick();
      await sleep(TICK_MS);
    }
  }
}

module.exports = {
  AIR,
  NervCarpetPrinter,
  stacksRequired,
  ticksFromMs
};
