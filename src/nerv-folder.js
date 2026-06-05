const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeBlockName } = require('./nerv-nbt');

function sortLikeAddon(files) {
  return [...files].sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
}

async function findNextMapFile(folder, startedFiles = [], areMoved = false) {
  if (!folder) return null;
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const maps = sortLikeAddon(
    entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.nbt'))
  );
  for (const map of maps) {
    const mapPath = path.join(folder, map.name);
    if (areMoved || !startedFiles.includes(mapPath)) return mapPath;
  }
  return null;
}

async function loadNervConfig(folder, configFile) {
  if (!folder || !configFile) return null;
  const configPath = path.join(folder, '_configs', configFile);
  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);
  return { path: configPath, config };
}

function applyNervConfig(runtimeConfig, nervConfigResult) {
  if (!nervConfigResult) return runtimeConfig;
  const { config } = nervConfigResult;

  if (config.type && !runtimeConfig.printer.modeProvided) {
    runtimeConfig.printer.mode = config.type;
  }

  if (config.mapCorner && !runtimeConfig.printer.originProvided) {
    runtimeConfig.printer.origin = {
      x: Number(config.mapCorner.x),
      y: Number(config.mapCorner.y),
      z: Number(config.mapCorner.z)
    };
  }

  runtimeConfig.nerv.loadedConfigPath = nervConfigResult.path;
  runtimeConfig.nerv.loadedType = config.type || null;
  runtimeConfig.nerv.materialCount = Object.keys(config.materialDict || {}).length;
  runtimeConfig.nerv.carpetConfig = carpetConfigFromJson(config);
  runtimeConfig.nerv.materialChests = materialChestsFromConfig(config);

  return runtimeConfig;
}

function blockPosFromJson(pos) {
  if (!pos) return null;
  return {
    x: Number(pos.x),
    y: Number(pos.y),
    z: Number(pos.z)
  };
}

function vec3FromJson(pos) {
  if (!pos) return null;
  return {
    x: Number(pos.x),
    y: Number(pos.y),
    z: Number(pos.z)
  };
}

function blockInteractionFromJson(entry) {
  if (!entry?.blockPos || !entry?.openPos) return null;
  return {
    blockPos: blockPosFromJson(entry.blockPos),
    openPos: vec3FromJson(entry.openPos)
  };
}

function carpetConfigFromJson(config) {
  if (!config || config.type !== 'carpet') return null;
  return {
    type: config.type,
    reset: blockInteractionFromJson(config.reset),
    cartographyTable: blockInteractionFromJson(config.cartographyTable),
    finishedMapChest: blockInteractionFromJson(config.finishedMapChest),
    mapMaterialChests: Array.isArray(config.mapMaterialChests)
      ? config.mapMaterialChests.map(blockInteractionFromJson).filter(Boolean)
      : [],
    dumpStation: config.dumpStation
      ? {
          pos: vec3FromJson(config.dumpStation.pos),
          yaw: Number(config.dumpStation.yaw),
          pitch: Number(config.dumpStation.pitch)
        }
      : null,
    mapCorner: blockPosFromJson(config.mapCorner),
    materialChests: materialChestsFromConfig(config)
  };
}

function materialChestsFromConfig(config) {
  const materialChests = {};
  for (const [blockName, entries] of Object.entries(config.materialDict || {})) {
    const normalized = normalizeBlockName(blockName);
    if (!normalized || !Array.isArray(entries)) continue;
    materialChests[normalized] = entries
      .filter((entry) => entry?.blockPos && entry?.openPos)
      .map(blockInteractionFromJson)
      .filter(Boolean);
  }
  return materialChests;
}

module.exports = {
  applyNervConfig,
  blockInteractionFromJson,
  blockPosFromJson,
  carpetConfigFromJson,
  findNextMapFile,
  loadNervConfig,
  materialChestsFromConfig,
  sortLikeAddon
};
