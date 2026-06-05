#!/usr/bin/env node
require('dotenv').config();

const path = require('node:path');
const mineflayer = require('mineflayer');
const mcDataLoader = require('minecraft-data');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { loadConfig } = require('./config');
const { loadFlatMap } = require('./nbt-loader');
const { applyNervConfig, findNextMapFile, loadNervConfig } = require('./nerv-folder');
const { makePlacementPlan } = require('./placement-plan');
const { NervCarpetPrinter } = require('./nerv-carpet-printer');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FOOD_ITEMS = new Set([
  'apple', 'baked_potato', 'beef', 'beetroot', 'beetroot_soup', 'bread', 'carrot',
  'chicken', 'chorus_fruit', 'cooked_beef', 'cooked_chicken', 'cooked_cod',
  'cooked_mutton', 'cooked_porkchop', 'cooked_rabbit', 'cooked_salmon', 'cookie',
  'dried_kelp', 'golden_apple', 'enchanted_golden_apple', 'golden_carrot',
  'melon_slice', 'mushroom_stew', 'mutton', 'porkchop', 'potato', 'pumpkin_pie',
  'rabbit', 'rabbit_stew', 'salmon', 'cod', 'suspicious_stew', 'sweet_berries',
  'glow_berries', 'tropical_fish'
]);

function safeStringify(value) {
  return JSON.stringify(value, (_key, entry) => (
    typeof entry === 'bigint' ? entry.toString() : entry
  ));
}

function printRequirements(requirements) {
  console.log('Required blocks:');
  for (const requirement of requirements) {
    console.log(`  ${requirement.name}: ${requirement.count}`);
  }
}

function printPlanPreview(mapFile, map, placements) {
  console.log(`Map: ${mapFile}`);
  console.log(`Detected source offset: x=${map.sourceOffset.x}, z=${map.sourceOffset.z}, topY=${map.maxHeight}`);
  printRequirements(map.requirements);
  console.log(`Planned placements: ${placements.length}`);
  for (const placement of placements.slice(0, 10)) {
    const pos = placement.position;
    console.log(
      `  #${placement.index + 1} ${placement.blockName} -> ${pos.x},${pos.y},${pos.z} (cell ${placement.x},${placement.z})`
    );
  }
}

function printPreflight(config, map, placements) {
  const supportedVersions = mcDataLoader.supportedVersions?.pc || [];
  const version = config.bot.version || 'auto';
  const missingChests = map.requirements
    .filter((requirement) => !config.nerv.materialChests?.[requirement.name]?.length)
    .map((requirement) => requirement.name);

  console.log('Preflight:');
  console.log(`  server: ${config.bot.host}:${config.bot.port}`);
  console.log(`  username: ${config.bot.username}`);
  console.log(`  auth: ${config.bot.auth}`);
  console.log(`  version: ${version}`);
  if (config.bot.version && !supportedVersions.includes(config.bot.version)) {
    console.log(`  WARNING: minecraft-data does not list ${config.bot.version} as supported.`);
  }
  console.log(`  login command configured: ${config.startup.loginCommand ? 'yes' : 'no'}`);
  console.log(`  post-login wait: ${config.startup.postLoginWaitMs}ms`);
  console.log(`  forward walk: ${config.startup.walkAfterLoginMs}ms`);
  console.log(`  post-portal settle: ${config.startup.postPortalSettleMs}ms`);
  console.log(`  world-ready timeout: ${config.startup.worldReadyTimeoutMs}ms`);
  console.log(`  lobby detect: radius=${config.startup.lobbyDetectRadius} wait=${config.startup.lobbyDetectMs}ms`);
  console.log(`  origin: ${config.printer.origin.x},${config.printer.origin.y},${config.printer.origin.z}`);
  console.log(`  map: ${config.printer.mapFile}`);
  console.log(`  placements: ${placements.length}`);
  console.log(
    `  printer speed: lines=${config.printer.linesPerRun} range=${config.printer.placeRange} ` +
    `delay=${config.printer.placeDelayMs}ms fill=${config.printer.mapFillSquareSize}`
  );
  console.log(
    `  print strategy: ${config.printer.printStrategy} ` +
    `sealEdge=${config.printer.sealEdgeMargin} lookbehind=${config.printer.sealLookbehindBlocks} ` +
    `holdBehind=${config.printer.sealMovementHoldBehind} ` +
    `urgentBurst=${config.printer.sealUrgentBurst} backtrack=${config.printer.sealMaxBacktrackBlocks} ` +
    `placeBurst=${config.printer.placementBurst}`
  );
  console.log(
    `  anti-velocity: ${config.printer.antiVelocity !== false ? 'on' : 'off'}` +
    `${config.printer.antiVelocityLiquid !== false ? ' (liquid on)' : ''}`
  );
  console.log(`  material chest colors loaded: ${Object.keys(config.nerv.materialChests || {}).length}`);
  console.log(`  carpet automation: dump/restock/build/map-lock/store/reset/next-map`);
  if (missingChests.length > 0) {
    console.log(`  WARNING: missing material chest registrations for ${missingChests.join(', ')}`);
  } else {
    console.log('  material chest coverage: ok');
  }
}

async function loadConfiguredMap(config) {
  const nervConfig = await loadNervConfig(config.nerv.folder, config.nerv.configFile);
  applyNervConfig(config, nervConfig);

  if (!config.printer.mapFile && config.nerv.folder) {
    config.printer.mapFile = await findNextMapFile(config.nerv.folder);
  }

  if (config.printer.mode !== 'flat' && config.printer.mode !== 'carpet') {
    throw new Error(`Unsupported BOT_MODE=${config.printer.mode}. Current port supports flat/carpet mode only.`);
  }

  if (config.nerv.loadedConfigPath) {
    console.log(`Loaded NERV config: ${config.nerv.loadedConfigPath}`);
    console.log(`Config type=${config.nerv.loadedType} materials=${config.nerv.materialCount}`);
  }

  const map = await loadFlatMap(config.printer.mapFile);
  const placements = makePlacementPlan(map, config.printer.origin);
  return { map, placements };
}

function wireChatControls(bot, printer, owner) {
  bot.on('chat', async (username, message) => {
    if (!owner || username !== owner) return;
    if (message === '!start') {
      printer.resume();
      printer.run().catch((error) => {
        console.error(error);
        bot.chat(`Printer stopped: ${error.message}`);
      });
    }
    if (message === '!pause') {
      printer.pause();
      bot.chat('Printer paused.');
    }
    if (message === '!resume') {
      printer.resume();
      bot.chat('Printer resumed.');
    }
    if (message === '!stop') {
      printer.stop();
      bot.chat('Printer stopped.');
    }
    if (message === '!status') {
      const status = printer.status();
      bot.chat(`Printer state=${status.state} checkpoints=${status.checkpoints} restock=${status.restockItems} sent=${status.sentPlacements}`);
    }
  });
}

function wireConnectionDiagnostics(bot, enabled = false) {
  bot.on('messagestr', (message, position) => {
    if (enabled) console.log(`[chat:${position}] ${message}`);
  });
  bot.on('title', (title, type) => {
    if (enabled) console.log(`[title:${type}] ${title}`);
  });
  bot.on('windowOpen', (window) => {
    if (enabled) console.log(`[window] opened ${window.type || window.title || window.id}`);
  });
  bot.on('respawn', () => {
    if (enabled) console.log(`[respawn] dimension=${bot.game?.dimension || 'unknown'}`);
  });
  bot.on('forcedMove', () => {
    if (!enabled) return;
    const pos = bot.entity?.position;
    if (pos) console.log(`[forcedMove] ${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}`);
  });
  bot.on('resourcePack', () => {
    console.log('[resourcePack] accepting resource pack');
    bot.acceptResourcePack?.();
  });

  const packetNames = [
    'start_configuration',
    'finish_configuration',
    'transfer',
    'store_cookie',
    'cookie_request',
    'kick_disconnect',
    'disconnect'
  ];
  for (const name of packetNames) {
    bot._client.on(name, (packet) => {
      if (enabled || name === 'transfer' || name.includes('disconnect') || name === 'kick_disconnect') {
        console.log(`[packet:${name}] ${safeStringify(packet)}`);
      }
    });
  }
}

function wireTransferGuard(bot) {
  let spawnedOnce = false;
  bot.once('spawn', () => {
    spawnedOnce = true;
  });

  function freeze(reason) {
    if (!spawnedOnce) return;
    console.log(`[guard] freezing physics/movement during ${reason}`);
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    bot.physicsEnabled = false;
  }

  function thaw(reason) {
    if (!spawnedOnce) return;
    console.log(`[guard] restoring physics after ${reason}`);
    setTimeout(() => {
      bot.physicsEnabled = true;
    }, 1000);
  }

  bot._client.on('start_configuration', () => freeze('configuration'));
  bot._client.on('transfer', () => freeze('transfer'));
  bot._client.on('finish_configuration', () => thaw('configuration'));
  bot.on('spawn', () => thaw('spawn'));
}

function horizontalDistance(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function isLobbyPosition(pos, startup, printer) {
  if (!pos || startup.lobbyDetectMs <= 0 || startup.lobbyDetectRadius <= 0) return false;
  const nearZero = horizontalDistance(pos, { x: 0, z: 0 }) <= startup.lobbyDetectRadius;
  const farFromBuild = horizontalDistance(pos, printer.origin) > startup.worldReadyDistance;
  return nearZero && farFromBuild && pos.y > 0 && pos.y < 400;
}

async function waitForWorldReady(bot, startup, printer) {
  if (startup.worldReadyTimeoutMs <= 0) return;
  const startedAt = Date.now();
  let lastLogAt = 0;
  let lobbySince = 0;
  while (Date.now() - startedAt < startup.worldReadyTimeoutMs) {
    throwIfEnded(bot);
    const pos = bot.entity?.position;
    if (pos) {
      const distance = horizontalDistance(pos, printer.origin);
      const saneY = pos.y > 0 && pos.y < 400;
      const nearBuild = distance <= startup.worldReadyDistance;
      if (saneY && nearBuild && bot.physicsEnabled !== false) {
        console.log(`World ready at ${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)} distance=${distance.toFixed(1)}`);
        return;
      }
      if (isLobbyPosition(pos, startup, printer)) {
        lobbySince ||= Date.now();
        if (Date.now() - lobbySince >= startup.lobbyDetectMs) {
          throw new Error('Lobby detected around 0,0 during startup.');
        }
      } else {
        lobbySince = 0;
      }
      if (Date.now() - lastLogAt > 5000) {
        lastLogAt = Date.now();
        console.log(
          `Waiting for world ready: pos=${pos.x.toFixed(2)},${pos.y.toFixed(2)},${pos.z.toFixed(2)} ` +
          `distance=${distance.toFixed(1)} physics=${bot.physicsEnabled !== false}`
        );
      }
    }
    await sleep(1000);
  }
  throw new Error(`World did not become ready near map origin within ${startup.worldReadyTimeoutMs}ms.`);
}

async function runStartupSequence(bot, startup, printer) {
  if (startup.loginCommand) {
    console.log('Sending configured login command.');
    bot.chat(startup.loginCommand);
  }

  if (startup.postLoginWaitMs > 0) {
    console.log(`Waiting ${startup.postLoginWaitMs}ms after login.`);
    await sleep(startup.postLoginWaitMs);
  }

  if (startup.walkAfterLoginMs > 0) {
    console.log(`Walking forward for ${startup.walkAfterLoginMs}ms.`);
    try {
      bot.setControlState('forward', true);
      await sleep(startup.walkAfterLoginMs);
    } finally {
      bot.setControlState('forward', false);
    }
  }

  if (startup.postPortalSettleMs > 0) {
    console.log(`Waiting ${startup.postPortalSettleMs}ms for portal/server transfer to settle.`);
    await sleep(startup.postPortalSettleMs);
  }

  await waitForWorldReady(bot, startup, printer);
}

function throwIfEnded(bot) {
  if (!bot.player || !bot._client?.socket || bot._client.socket.destroyed) {
    throw new Error('Bot disconnected during startup.');
  }
}

function isRestartNotice(message) {
  const normalized = String(message || '').toLowerCase();
  return (
    /(?:server|6b6t).{0,40}restart/.test(normalized) ||
    /restart.{0,40}(?:server|6b6t|backup)/.test(normalized) ||
    /finding.{0,40}backup/.test(normalized) ||
    /backup.{0,40}(?:server|menu)/.test(normalized) ||
    /reboot.{0,40}(?:server|6b6t)/.test(normalized)
  );
}

function isFoodItem(item) {
  return Boolean(item && (FOOD_ITEMS.has(item.name) || item.name.endsWith('_stew')));
}

function wireRuntimeGuards(bot, printer, config, requestEnd) {
  let lobbySince = 0;
  let eating = false;
  let lastNoFoodLogAt = 0;
  let antiVelocityCancels = 0;
  let lastAntiVelocityLogAt = Date.now();

  if (config.printer.antiVelocity !== false) {
    console.log('[guard] Anti-velocity enabled.');
    if (config.printer.antiVelocityLiquid !== false) console.log('[guard] Anti-velocity liquid mode enabled.');
    const shouldSuppressAntiVelocity = () => printer.shouldSuppressAntiVelocityDuringWaterTravel?.();
    if (bot._client && !bot._client.__nervAntiVelocityPatched) {
      const rawEmit = bot._client.emit.bind(bot._client);
      bot._client.emit = (eventName, packet, ...args) => {
        if (!shouldSuppressAntiVelocity()) {
          if (eventName === 'entity_velocity') {
            const id = packet?.entityId ?? packet?.entityID;
            if (id === bot.entity?.id && packet?.velocity) {
              packet.velocity.x = 0;
              packet.velocity.y = 0;
              packet.velocity.z = 0;
            }
          } else if (eventName === 'explosion' && packet) {
            if (packet.playerKnockback) {
              packet.playerKnockback.x = 0;
              packet.playerKnockback.y = 0;
              packet.playerKnockback.z = 0;
            }
            if ('playerMotionX' in packet) {
              packet.playerMotionX = 0;
              packet.playerMotionY = 0;
              packet.playerMotionZ = 0;
            }
          }
        } else if (eventName === 'entity_velocity' || eventName === 'explosion') {
          const phase = printer.waterMotionPhase?.() || 'unknown';
          if (phase === 'travel') {
            console.log(`[guard] antiVelocity travel suppression active for ${eventName}.`);
          }
        }
        return rawEmit(eventName, packet, ...args);
      };
      bot._client.__nervAntiVelocityPatched = true;
      console.log('[guard] Anti-velocity packet patch active.');
    }
    const zeroVelocity = (source = 'unknown') => {
      if (printer.shouldSuppressAntiVelocityDuringWaterTravel?.()) return;
      if (!bot.entity?.velocity?.set) return;
      bot.entity.velocity.set(0, 0, 0);
      printer.zeroVelocityForResetWater?.();
      antiVelocityCancels += 1;
      const now = Date.now();
      if (now - lastAntiVelocityLogAt >= 30000) {
        lastAntiVelocityLogAt = now;
        console.log(`[guard] antiVelocity cancels=${antiVelocityCancels} last=${source}`);
      }
    };
    bot._client?.on?.('entity_velocity', (packet) => {
      const id = packet.entityId ?? packet.entityID;
      if (id !== bot.entity?.id || !bot.entity?.velocity) return;
      zeroVelocity('entity_velocity');
      setImmediate(() => zeroVelocity('entity_velocity:post'));
    });
    bot._client?.on?.('explosion', () => {
      zeroVelocity('explosion');
      setImmediate(() => zeroVelocity('explosion:post'));
    });
    bot.on('forcedMove', () => {
      zeroVelocity('forcedMove');
      setTimeout(() => zeroVelocity('forcedMove:50ms'), 50);
      setTimeout(() => zeroVelocity('forcedMove:150ms'), 150);
    });
  }

  bot.on('messagestr', (message) => {
    if (!isRestartNotice(message)) return;
    console.log('[server] Restart/backup notice detected; reconnecting after wait.');
    requestEnd('server restart notice');
  });

  bot.on('death', () => {
    console.log('[survival] Death detected; respawn then reconnect.');
    setTimeout(() => bot.respawn?.(), 2000);
    setTimeout(() => requestEnd('death detected'), 5000);
  });

  async function maybeEat() {
    if (eating || bot.food === undefined || bot.food > config.printer.eatFoodThreshold) return;
    if (bot.currentWindow) return;
    const food = bot.inventory?.items?.().find(isFoodItem);
    if (!food) {
      if (Date.now() - lastNoFoodLogAt > 60000) {
        lastNoFoodLogAt = Date.now();
        console.log(`[survival] Food=${bot.food}; no food item found in inventory.`);
      }
      return;
    }

    eating = true;
    const paused = printer.running && printer.state !== 'Paused';
    try {
      if (paused) printer.pause();
      console.log(`[survival] Food=${bot.food}; eating ${food.name}.`);
      await bot.equip(food, 'hand');
      await bot.consume();
    } catch (error) {
      console.warn(`[survival] Eat failed: ${error.message}`);
    } finally {
      if (paused && printer.running) printer.resume();
      eating = false;
    }
  }

  bot.on('health', () => {
    maybeEat().catch((error) => console.warn(`[survival] Eat guard failed: ${error.message}`));
  });

  const interval = setInterval(() => {
    maybeEat().catch((error) => console.warn(`[survival] Eat guard failed: ${error.message}`));
    const pos = bot.entity?.position;
    if (isLobbyPosition(pos, config.startup, config.printer)) {
      lobbySince ||= Date.now();
      if (Date.now() - lobbySince >= config.startup.lobbyDetectMs) {
        console.log('[server] Lobby/menu position detected around 0,0; reconnecting.');
        requestEnd('lobby detected');
      }
    } else {
      lobbySince = 0;
    }
  }, 2000);
  interval.unref?.();
  bot.once('end', () => clearInterval(interval));
}

async function runBot(config, map, placements) {
  return new Promise((resolve) => {
  const botOptions = Object.fromEntries(Object.entries(config.bot).filter(([, value]) => value !== undefined));
  const bot = mineflayer.createBot(botOptions);
  bot.loadPlugin(pathfinder);
  wireConnectionDiagnostics(bot, config.printer.debugPrints || config.command === 'smoke');
  wireTransferGuard(bot);
  let endReason = 'ended';
  let ending = false;
  let startupReady = false;
  function requestEnd(reason) {
    if (ending) return;
    ending = true;
    endReason = reason;
    printer.stop();
    bot.end(reason);
  }

  const printer = new NervCarpetPrinter(bot, config, {
    nervFolder: config.nerv.folder,
    mapFile: config.printer.mapFile,
    map
  });
  wireChatControls(bot, printer, config.printer.owner);
  wireRuntimeGuards(bot, printer, config, requestEnd);

  bot.once('spawn', async () => {
    const mcData = mcDataLoader(bot.version);
    bot.pathfinder.setMovements(new Movements(bot, mcData));
    console.log(`Bot spawned as ${bot.username}. Planned placements: ${placements.length}`);

    try {
      await runStartupSequence(bot, config.startup, config.printer);
      throwIfEnded(bot);
      startupReady = true;

      if (config.command === 'smoke' || config.printer.runMode === 'smoke') {
        console.log('Smoke mode: startup complete, idling without printing.');
        setTimeout(() => {
          console.log('Smoke mode complete; disconnecting.');
          bot.end('smoke complete');
        }, config.printer.smokeIdleMs);
        return;
      }

      if (config.printer.autoStart) {
        printer.run().catch((error) => {
          console.error(error);
          requestEnd(`printer error: ${error.message}`);
        });
      }
    } catch (error) {
      console.error(error);
      requestEnd(`startup error: ${error.message}`);
    }
  });

  bot.on('kicked', (reason) => {
    endReason = safeStringify(reason);
    console.error('Kicked:', reason);
    requestEnd(`kicked: ${endReason}`);
  });
  bot.on('error', (error) => {
    if (endReason === 'ended') endReason = error.message;
    console.error('Bot error:', error);
    requestEnd(`bot error: ${error.message}`);
  });
  bot.on('end', () => {
    printer.stop();
    console.log('Bot disconnected.');
    resolve({ reason: endReason, startupReady });
  });
  });
}

function isRestartReason(reason) {
  const text = String(reason || '').toLowerCase();
  return text.includes('restart') || text.includes('backup');
}

function reconnectDelayForReason(reason, printerConfig, restartRetryDepth = 0) {
  const text = String(reason || '').toLowerCase();
  if (text.includes('already online')) return printerConfig.onlineRetryDelayMs;
  if (isRestartReason(reason)) {
    return restartRetryDepth <= 1
      ? printerConfig.restartReconnectQuickDelayMs
      : printerConfig.restartReconnectDelayMs;
  }
  if (text.includes('lobby')) return printerConfig.lobbyReconnectDelayMs;
  return printerConfig.reconnectDelayMs;
}

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const config = loadConfig({ rootDir });

  if (config.command === 'plan' || config.printer.dryRun) {
    const { map, placements } = await loadConfiguredMap(config);
    printPlanPreview(config.printer.mapFile, map, placements);
    return;
  }

  if (config.command === 'preflight') {
    const { map, placements } = await loadConfiguredMap(config);
    printPlanPreview(config.printer.mapFile, map, placements);
    printPreflight(config, map, placements);
    return;
  }

  if (config.command !== 'run' && config.command !== 'smoke') {
    throw new Error(`Unknown command "${config.command}". Use "plan", "preflight", "smoke", or "run".`);
  }

  let attempt = 0;
  let restartRetryDepth = 0;
  while (true) {
    const runConfig = loadConfig({ rootDir });
    const { map: runMap, placements: runPlacements } = await loadConfiguredMap(runConfig);
    printPlanPreview(runConfig.printer.mapFile, runMap, runPlacements);
    const result = await runBot(runConfig, runMap, runPlacements);
    if (runConfig.command === 'smoke' || runConfig.printer.runMode === 'smoke' || !runConfig.printer.reconnect) break;
    attempt += 1;
    const reason = String(result.reason || '');
    if (isRestartReason(reason)) {
      restartRetryDepth = result.startupReady ? 1 : restartRetryDepth + 1;
    } else {
      restartRetryDepth = 0;
    }
    const delay = reconnectDelayForReason(reason, runConfig.printer, restartRetryDepth);
    console.log(`Reconnect #${attempt} in ${delay}ms after: ${reason}`);
    await sleep(delay);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
