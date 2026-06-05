const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SingleBotPrinter {
  constructor(bot, placements, options = {}) {
    this.bot = bot;
    this.placements = placements;
    this.placeDelayMs = options.placeDelayMs ?? 50;
    this.reach = options.reach ?? 4.5;
    this.materialChests = options.materialChests || {};
    this.index = 0;
    this.paused = false;
    this.stopped = false;
    this.running = false;
  }

  status() {
    return {
      running: this.running,
      paused: this.paused,
      stopped: this.stopped,
      index: this.index,
      total: this.placements.length
    };
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  stop() {
    this.stopped = true;
    this.paused = false;
    this.bot.pathfinder?.setGoal(null);
  }

  async waitWhilePaused() {
    while (this.paused && !this.stopped) {
      await sleep(250);
    }
  }

  findInventoryItem(blockName) {
    return this.bot.inventory.items().find((item) => item.name === blockName);
  }

  async equipForPlacement(blockName) {
    let item = this.findInventoryItem(blockName);
    if (!item && this.materialChests[blockName]?.length) {
      await this.restockBlock(blockName);
      item = this.findInventoryItem(blockName);
    }
    if (!item) {
      throw new Error(`Missing required item in inventory: ${blockName}`);
    }
    await this.bot.equip(item, 'hand');
  }

  isNear(position) {
    const targetCenter = new Vec3(position.x + 0.5, position.y + 0.5, position.z + 0.5);
    return this.bot.entity.position.distanceTo(targetCenter) <= this.reach;
  }

  async moveNear(position) {
    if (this.isNear(position)) return;
    const goal = new goals.GoalNear(position.x, position.y, position.z, Math.max(1, Math.floor(this.reach - 1)));
    await this.bot.pathfinder.goto(goal);
  }

  async moveToOpenPos(openPos) {
    const goal = new goals.GoalNear(openPos.x, openPos.y, openPos.z, 1);
    await this.bot.pathfinder.goto(goal);
  }

  itemCount(blockName) {
    return this.bot.inventory.items()
      .filter((item) => item.name === blockName)
      .reduce((sum, item) => sum + item.count, 0);
  }

  emptySlotCount() {
    if (typeof this.bot.inventory.emptySlotCount === 'function') {
      return this.bot.inventory.emptySlotCount();
    }
    return this.bot.inventory.slots.filter((slot) => slot === null).length;
  }

  async openChestAt(entry) {
    await this.moveToOpenPos(entry.openPos);
    const chestPos = new Vec3(entry.blockPos.x, entry.blockPos.y, entry.blockPos.z);
    const chestBlock = this.bot.blockAt(chestPos);
    if (!chestBlock) {
      throw new Error(`Could not see material chest at ${entry.blockPos.x},${entry.blockPos.y},${entry.blockPos.z}.`);
    }
    await this.bot.lookAt(chestBlock.position.offset(0.5, 0.5, 0.5), true);
    if (typeof this.bot.openChest === 'function') return this.bot.openChest(chestBlock);
    return this.bot.openContainer(chestBlock);
  }

  async restockBlock(blockName) {
    if (this.emptySlotCount() < 1) {
      throw new Error(`No empty inventory slot available to restock ${blockName}. Dumping is not ported yet.`);
    }

    const itemDef = this.bot.registry.itemsByName[blockName];
    if (!itemDef) {
      throw new Error(`Mineflayer registry does not know item ${blockName}.`);
    }

    const chests = this.materialChests[blockName] || [];
    let lastError = null;

    for (const chestEntry of chests) {
      let chest = null;
      try {
        chest = await this.openChestAt(chestEntry);
        const available = chest.containerItems()
          .filter((item) => item.name === blockName)
          .reduce((sum, item) => sum + item.count, 0);
        if (available <= 0) continue;

        const amount = Math.min(64, available);
        await chest.withdraw(itemDef.id, null, amount);
        await sleep(150);
        if (this.itemCount(blockName) > 0) return;
      } catch (error) {
        lastError = error;
      } finally {
        if (chest) chest.close();
      }
    }

    if (lastError) {
      throw new Error(`Failed restocking ${blockName}: ${lastError.message}`);
    }
    throw new Error(`No registered material chest had ${blockName}.`);
  }

  getPlaceTarget(placement) {
    const target = new Vec3(placement.position.x, placement.position.y, placement.position.z);
    const existing = this.bot.blockAt(target);
    if (existing && existing.name === placement.blockName) return null;
    if (existing && existing.name !== 'air' && existing.name !== 'cave_air' && existing.name !== 'void_air') {
      throw new Error(
        `Target ${target.x},${target.y},${target.z} already contains ${existing.name}, expected air or ${placement.blockName}.`
      );
    }

    const reference = this.bot.blockAt(target.offset(0, -1, 0));
    if (!reference || reference.name === 'air') {
      throw new Error(`No support block below ${target.x},${target.y},${target.z}.`);
    }
    return { target, reference };
  }

  async placeAt(placement) {
    await this.moveNear(placement.position);

    let placeTarget = this.getPlaceTarget(placement);
    if (!placeTarget) return;

    await this.equipForPlacement(placement.blockName);
    await this.moveNear(placement.position);

    placeTarget = this.getPlaceTarget(placement);
    if (!placeTarget) return;

    await this.bot.lookAt(placeTarget.target.offset(0.5, 0.5, 0.5), true);
    await this.bot.placeBlock(placeTarget.reference, new Vec3(0, 1, 0));
    await sleep(this.placeDelayMs);
  }

  async run() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;

    try {
      for (; this.index < this.placements.length; this.index += 1) {
        if (this.stopped) break;
        await this.waitWhilePaused();
        if (this.stopped) break;
        await this.placeAt(this.placements[this.index]);
      }
    } finally {
      this.running = false;
    }
  }
}

module.exports = {
  SingleBotPrinter
};
