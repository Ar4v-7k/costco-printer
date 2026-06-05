const path = require('node:path');

function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return parsed;
}

function parseVersion(value) {
  if (!value || value === 'false' || value === 'auto') return undefined;
  return value;
}

function parseEnum(value, allowed, defaultValue) {
  if (!value) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  return allowed.find((entry) => entry.toLowerCase() === normalized) || defaultValue;
}

function parseViewDistance(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return String(value);
}

function readCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function resolveMaybeRelative(rootDir, filePath) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
}

function loadConfig({ argv = process.argv.slice(2), env = process.env, rootDir = process.cwd() } = {}) {
  const cli = readCliArgs(argv);
  const command = cli._command || argv.find((arg) => !arg.startsWith('--')) || 'plan';
  const mapFile = cli.map || env.BOT_MAP_FILE;
  const originProvided =
    cli.originX !== undefined ||
    cli.originY !== undefined ||
    cli.originZ !== undefined ||
    env.BOT_ORIGIN_X ||
    env.BOT_ORIGIN_Y ||
    env.BOT_ORIGIN_Z;
  const modeProvided = cli.mode !== undefined || Boolean(env.BOT_MODE);

  return {
    command,
    nerv: {
      folder: resolveMaybeRelative(rootDir, cli.nervFolder || env.BOT_NERV_FOLDER),
      configFile: cli.configFile || env.BOT_CONFIG_FILE || ''
    },
    bot: {
      host: cli.host || env.BOT_HOST || 'play.6b6t.org',
      port: parseNumber(cli.port || env.BOT_PORT, 25565),
      username: cli.username || env.BOT_USERNAME || 'CostcoBot',
      auth: cli.auth || env.BOT_AUTH || 'offline',
      version: parseVersion(cli.version || env.BOT_VERSION),
      viewDistance: parseViewDistance(cli.viewDistance || env.BOT_VIEW_DISTANCE, 2),
      chat: parseEnum(cli.chat || env.BOT_CHAT, ['enabled', 'commandsOnly', 'disabled'], 'commandsOnly'),
      plugins: {
        boss_bar: false,
        particle: false,
        rain: false,
        scoreboard: false,
        sound: false,
        tablist: false,
        team: false,
        time: false,
        title: false
      }
    },
    startup: {
      loginCommand: cli.loginCommand || env.BOT_LOGIN_COMMAND || '',
      postLoginWaitMs: parseNumber(cli.postLoginWaitMs || env.BOT_POST_LOGIN_WAIT_MS, 0),
      walkAfterLoginMs: parseNumber(cli.walkAfterLoginMs || env.BOT_WALK_AFTER_LOGIN_MS, 0),
      postPortalSettleMs: parseNumber(cli.postPortalSettleMs || env.BOT_POST_PORTAL_SETTLE_MS, 8000),
      worldReadyTimeoutMs: parseNumber(cli.worldReadyTimeoutMs || env.BOT_WORLD_READY_TIMEOUT_MS, 60000),
      worldReadyDistance: parseNumber(cli.worldReadyDistance || env.BOT_WORLD_READY_DISTANCE, 1024),
      lobbyDetectRadius: parseNumber(cli.lobbyDetectRadius || env.BOT_LOBBY_DETECT_RADIUS, 512),
      lobbyDetectMs: parseNumber(cli.lobbyDetectMs || env.BOT_LOBBY_DETECT_MS, 8000)
    },
    printer: {
      mode: cli.mode || env.BOT_MODE || 'flat',
      modeProvided,
      mapFile: resolveMaybeRelative(rootDir, mapFile),
      origin: {
        x: parseNumber(cli.originX || env.BOT_ORIGIN_X, 0),
        y: parseNumber(cli.originY || env.BOT_ORIGIN_Y, 64),
        z: parseNumber(cli.originZ || env.BOT_ORIGIN_Z, 0)
      },
      originProvided,
      autoStart: parseBool(cli.autoStart ?? env.BOT_AUTO_START, true),
      dryRun: parseBool(cli.dryRun ?? env.BOT_DRY_RUN, false),
      owner: cli.owner || env.BOT_OWNER || '',
      placeDelayMs: parseNumber(cli.placeDelayMs || env.BOT_PLACE_DELAY_MS, 20),
      printStrategy: parseEnum(cli.printStrategy || env.BOT_PRINT_STRATEGY, ['sealed', 'closest'], 'sealed'),
      reach: parseNumber(cli.reach || env.BOT_REACH, 5),
      linesPerRun: parseNumber(cli.linesPerRun || env.BOT_LINES_PER_RUN, 5),
      placeRange: parseNumber(cli.placeRange || env.BOT_PLACE_RANGE, 5),
      minPlaceDistance: parseNumber(cli.minPlaceDistance || env.BOT_MIN_PLACE_DISTANCE, 0.8),
      mapFillSquareSize: parseNumber(cli.mapFillSquareSize || env.BOT_MAP_FILL_SQUARE_SIZE, 3),
      northToSouth: parseBool(cli.northToSouth ?? env.BOT_NORTH_TO_SOUTH, true),
      sprintMode: parseEnum(cli.sprintMode || env.BOT_SPRINT_MODE, ['Off', 'NotPlacing', 'Always'], 'NotPlacing'),
      sprintMinFood: parseNumber(cli.sprintMinFood || env.BOT_SPRINT_MIN_FOOD, 6),
      rotate: parseBool(cli.rotate ?? env.BOT_ROTATE, true),
      preRestockDelayMs: parseNumber(cli.preRestockDelayMs || env.BOT_PRE_RESTOCK_DELAY_MS, 500),
      invActionDelayMs: parseNumber(cli.invActionDelayMs || env.BOT_INV_ACTION_DELAY_MS, 100),
      postRestockDelayMs: parseNumber(cli.postRestockDelayMs || env.BOT_POST_RESTOCK_DELAY_MS, 300),
      restockSlotMode: parseEnum(cli.restockSlotMode || env.BOT_RESTOCK_SLOT_MODE, ['full', 'addon'], 'full'),
      preSwapDelayMs: parseNumber(cli.preSwapDelayMs || env.BOT_PRE_SWAP_DELAY_MS, 0),
      postSwapDelayMs: parseNumber(cli.postSwapDelayMs || env.BOT_POST_SWAP_DELAY_MS, 0),
      placementRetries: parseNumber(cli.placementRetries || env.BOT_PLACEMENT_RETRIES, 20),
      placementVerifyMs: parseNumber(cli.placementVerifyMs || env.BOT_PLACEMENT_VERIFY_MS, 0),
      placementPendingMs: parseNumber(cli.placementPendingMs || env.BOT_PLACEMENT_PENDING_MS, 150),
      placementRetryDelayMs: parseNumber(cli.placementRetryDelayMs || env.BOT_PLACEMENT_RETRY_DELAY_MS, 25),
      placementPruneMs: parseNumber(cli.placementPruneMs || env.BOT_PLACEMENT_PRUNE_MS, 100),
      placementAbandonMs: parseNumber(cli.placementAbandonMs || env.BOT_PLACEMENT_ABANDON_MS, 30000),
      placementCarefulAfterAttempts: parseNumber(
        cli.placementCarefulAfterAttempts || env.BOT_PLACEMENT_CAREFUL_AFTER_ATTEMPTS,
        8
      ),
      placementBurst: parseNumber(cli.placementBurst || env.BOT_PLACEMENT_BURST, 1),
      maxPlacementsPerTick: parseNumber(cli.maxPlacementsPerTick || env.BOT_MAX_PLACEMENTS_PER_TICK, 4),
      sealEdgeMargin: parseNumber(cli.sealEdgeMargin || env.BOT_SEAL_EDGE_MARGIN, 0.35),
      sealLookbehindBlocks: parseNumber(cli.sealLookbehindBlocks || env.BOT_SEAL_LOOKBEHIND_BLOCKS, 0.75),
      sealMovementHoldBehind: parseNumber(
        cli.sealMovementHoldBehind || env.BOT_SEAL_MOVEMENT_HOLD_BEHIND,
        0.6
      ),
      sealUrgentBurst: parseNumber(cli.sealUrgentBurst || env.BOT_SEAL_URGENT_BURST, 4),
      sealMaxBacktrackBlocks: parseNumber(cli.sealMaxBacktrackBlocks || env.BOT_SEAL_MAX_BACKTRACK_BLOCKS, 3),
      sealLogMs: parseNumber(cli.sealLogMs || env.BOT_SEAL_LOG_MS, 5000),
      maxFastPendingAir: parseNumber(cli.maxFastPendingAir || env.BOT_MAX_FAST_PENDING_AIR, 8),
      pendingHoldEdgeBuffer: parseNumber(cli.pendingHoldEdgeBuffer || env.BOT_PENDING_HOLD_EDGE_BUFFER, 1.25),
      backfillEdgeBuffer: parseNumber(cli.backfillEdgeBuffer || env.BOT_BACKFILL_EDGE_BUFFER, 1.25),
      holdOpenEdge: parseBool(cli.holdOpenEdge ?? env.BOT_HOLD_OPEN_EDGE, false),
      hotbarSettleMs: parseNumber(cli.hotbarSettleMs || env.BOT_HOTBAR_SETTLE_MS, 0),
      hotbarSwapConfirmMs: parseNumber(cli.hotbarSwapConfirmMs || env.BOT_HOTBAR_SWAP_CONFIRM_MS, 250),
      packetPlaceLook: parseBool(cli.packetPlaceLook ?? env.BOT_PACKET_PLACE_LOOK, false),
      fastPlacementReferences: parseBool(
        cli.fastPlacementReferences ?? env.BOT_FAST_PLACEMENT_REFERENCES,
        true
      ),
      sneakPlace: parseBool(cli.sneakPlace ?? env.BOT_SNEAK_PLACE, false),
      packetSneakPlace: parseBool(cli.packetSneakPlace ?? env.BOT_PACKET_SNEAK_PLACE, true),
      closeUnexpectedWindows: parseBool(cli.closeUnexpectedWindows ?? env.BOT_CLOSE_UNEXPECTED_WINDOWS, true),
      unsneakWhileWalking: parseBool(cli.unsneakWhileWalking ?? env.BOT_UNSNEAK_WHILE_WALKING, true),
      pathfinderForInteractTravel: parseBool(
        cli.pathfinderForInteractTravel ?? env.BOT_PATHFINDER_FOR_INTERACT_TRAVEL,
        true
      ),
      restockPartialFallback: parseBool(cli.restockPartialFallback ?? env.BOT_RESTOCK_PARTIAL_FALLBACK, false),
      missingRestockRetryMs: parseNumber(cli.missingRestockRetryMs || env.BOT_MISSING_RESTOCK_RETRY_MS, 10000),
      progressLogMs: parseNumber(cli.progressLogMs || env.BOT_PROGRESS_LOG_MS, 30000),
      walkingStallMs: parseNumber(cli.walkingStallMs || env.BOT_WALKING_STALL_MS, 15000),
      interactRecoveryMs: parseNumber(cli.interactRecoveryMs || env.BOT_INTERACT_RECOVERY_MS, 3000),
      interactRecoveryCycles: parseNumber(cli.interactRecoveryCycles || env.BOT_INTERACT_RECOVERY_CYCLES, 2),
      packetPrintMovement: parseBool(cli.packetPrintMovement ?? env.BOT_PACKET_PRINT_MOVEMENT, false),
      packetPrintSpeed: parseNumber(cli.packetPrintSpeed || env.BOT_PACKET_PRINT_SPEED, 5.6),
      packetPrintMaxStep: parseNumber(cli.packetPrintMaxStep || env.BOT_PACKET_PRINT_MAX_STEP, 0.45),
      resetChestCloseDelayMs: parseNumber(cli.resetChestCloseDelayMs || env.BOT_RESET_CHEST_CLOSE_DELAY_MS, 50),
      retryInteractMs: parseNumber(cli.retryInteractMs || env.BOT_RETRY_INTERACT_MS, 1000),
      interactRecoveryRetries: parseNumber(cli.interactRecoveryRetries || env.BOT_INTERACT_RECOVERY_RETRIES, 4),
      posResetTimeoutMs: parseNumber(cli.posResetTimeoutMs || env.BOT_POS_RESET_TIMEOUT_MS, 200),
      checkpointBuffer: parseNumber(cli.checkpointBuffer || env.BOT_CHECKPOINT_BUFFER, 0.2),
      minCheckpointBuffer: parseNumber(cli.minCheckpointBuffer || env.BOT_MIN_CHECKPOINT_BUFFER, 0.2),
      interactCheckpointBuffer: parseNumber(cli.interactCheckpointBuffer || env.BOT_INTERACT_CHECKPOINT_BUFFER, 0.85),
      printCheckpointSideTolerance: parseNumber(
        cli.printCheckpointSideTolerance || env.BOT_PRINT_CHECKPOINT_SIDE_TOLERANCE,
        1.5
      ),
      breakCarpetAboveReset: parseBool(cli.breakCarpetAboveReset ?? env.BOT_BREAK_CARPET_ABOVE_RESET, true),
      moveToFinishedFolder: parseBool(cli.moveToFinishedFolder ?? env.BOT_MOVE_TO_FINISHED_FOLDER, true),
      disableOnFinished: parseBool(cli.disableOnFinished ?? env.BOT_DISABLE_ON_FINISHED, true),
      errorAction: parseEnum(cli.errorAction || env.BOT_ERROR_ACTION, ['Ignore', 'ToggleOff', 'Reset', 'Repair'], 'Repair'),
      logErrors: parseBool(cli.logErrors ?? env.BOT_LOG_ERRORS, true),
      errorLogLimit: parseNumber(cli.errorLogLimit || env.BOT_ERROR_LOG_LIMIT, 25),
      resetDirtyMapErrorLimit: parseNumber(cli.resetDirtyMapErrorLimit || env.BOT_RESET_DIRTY_MAP_ERROR_LIMIT, 256),
      forceResetOnStart: parseBool(cli.forceResetOnStart ?? env.BOT_FORCE_RESET_ON_START, false),
      debugPrints: parseBool(cli.debugPrints ?? env.BOT_DEBUG_PRINTS, false),
      runMode: parseEnum(cli.runMode || env.BOT_RUN_MODE, ['smoke', 'print'], 'print'),
      smokeIdleMs: parseNumber(cli.smokeIdleMs || env.BOT_SMOKE_IDLE_MS, 30000),
      reconnect: parseBool(cli.reconnect ?? env.BOT_RECONNECT, true),
      reconnectDelayMs: parseNumber(cli.reconnectDelayMs || env.BOT_RECONNECT_DELAY_MS, 15000),
      onlineRetryDelayMs: parseNumber(cli.onlineRetryDelayMs || env.BOT_ONLINE_RETRY_DELAY_MS, 180000),
      restartReconnectQuickDelayMs: parseNumber(
        cli.restartReconnectQuickDelayMs || env.BOT_RESTART_RECONNECT_QUICK_DELAY_MS,
        30000
      ),
      restartReconnectDelayMs: parseNumber(cli.restartReconnectDelayMs || env.BOT_RESTART_RECONNECT_DELAY_MS, 420000),
      lobbyReconnectDelayMs: parseNumber(cli.lobbyReconnectDelayMs || env.BOT_LOBBY_RECONNECT_DELAY_MS, 15000),
      eatFoodThreshold: parseNumber(cli.eatFoodThreshold || env.BOT_EAT_FOOD_THRESHOLD, 14),
      drainResetWater: parseBool(cli.drainResetWater ?? env.BOT_DRAIN_RESET_WATER, true),
      waterDrainActionDelayMs: parseNumber(cli.waterDrainActionDelayMs || env.BOT_WATER_DRAIN_ACTION_DELAY_MS, 500),
      waterDrainVerifyMs: parseNumber(cli.waterDrainVerifyMs || env.BOT_WATER_DRAIN_VERIFY_MS, 1500),
      waterDrainVerifyChecks: parseNumber(cli.waterDrainVerifyChecks || env.BOT_WATER_DRAIN_VERIFY_CHECKS, 3),
      waterDrainOpenTimeoutMs: parseNumber(cli.waterDrainOpenTimeoutMs || env.BOT_WATER_DRAIN_OPEN_TIMEOUT_MS, 5000),
      waterDrainMaxAttempts: parseNumber(cli.waterDrainMaxAttempts || env.BOT_WATER_DRAIN_MAX_ATTEMPTS, 6),
      antiVelocity: parseBool(cli.antiVelocity ?? env.BOT_ANTI_VELOCITY, true),
      antiVelocityLiquid: parseBool(cli.antiVelocityLiquid ?? env.BOT_ANTI_VELOCITY_LIQUID, true),
      resetViewDistance: parseNumber(cli.resetViewDistance || env.BOT_RESET_VIEW_DISTANCE, 12),
      resetViewBoostMs: parseNumber(cli.resetViewBoostMs || env.BOT_RESET_VIEW_BOOST_MS, 5000)
    }
  };
}

module.exports = {
  loadConfig,
  parseBool,
  parseEnum,
  parseNumber,
  readCliArgs
};
