# NERV Printer Mineflayer Port

This is a single-bot Mineflayer port of Julflips' NERV Carpet Printer workflow. It keeps the Meteor/Fabric addon untouched and uses the same NERV config and `1x1` `.nbt` map folder.

The goal of this port is to copy the Java `CarpetPrinter` module's runtime behavior, with Mineflayer acting as the Minecraft client transport. It is not a generic pathfinder builder: the printer walks checkpoint lines, dumps/restocks, swaps hotbar slots, sends place packets, repairs bad blocks at line ends, locks the map, stores it, resets the area, and loads the next `.nbt`.

Current scope:

- One Mineflayer bot.
- Fully automated carpet-printer loop: dump, restock, build, create/lock/store map, reset, then load the next NBT.
- Saved NERV carpet configs, including reset chest, dump station, cartography table, finished-map chest, map-material chest, and material chests.
- Chat controls from `BOT_OWNER`: `!start`, `!pause`, `!resume`, `!stop`, `!status`.

Not ported:

- Multi-bot master/slave coordination.
- Staircased printer, fullblock printer, and map namer.

## Setup

```bash
cd mineflayer-port
npm install
cp .env.example .env
```

Edit `.env` with your server login, the `.nbt` file, and the map origin. `BOT_ORIGIN_X/Y/Z` is the target block position for NBT cell `x=0,z=0`.

The default template is aimed at 6b6t's Java server:

```env
BOT_HOST=play.6b6t.org
BOT_USERNAME=CostcoBot
BOT_AUTH=offline
BOT_LOGIN_COMMAND=/login your_password
BOT_POST_LOGIN_WAIT_MS=2000
BOT_WALK_AFTER_LOGIN_MS=5000
BOT_WORLD_READY_TIMEOUT_MS=60000
BOT_WORLD_READY_DISTANCE=1024
BOT_LOBBY_DETECT_RADIUS=512
BOT_LOBBY_DETECT_MS=8000
BOT_NERV_FOLDER=/Users/aravsharma/Library/Application Support/ModrinthApp/profiles/Fabulously Optimized (1)/nerv-printer
BOT_CONFIG_FILE=Flat Mapart Use Me.json
BOT_MAP_FILE=
```

`BOT_LOGIN_COMMAND` is intentionally only a local `.env` value. Keep the actual password out of git.

When `BOT_NERV_FOLDER` is set, the port loads:

- `mapCorner` and printer type from `_configs/BOT_CONFIG_FILE`.
- Registered material chests from `materialDict`, used for one-stack-at-a-time restocking.
- The next top-level `.nbt` map from the NERV folder when `BOT_MAP_FILE` is empty.

You can still override any of that with `BOT_MAP_FILE` or `BOT_ORIGIN_X/Y/Z`.

## How The Bot Works

The bot has two layers:

- `src/index.js` is the server wrapper. It logs into 6b6t, sends the cracked-account `/login` command, walks into the portal, waits for transfer/configuration packets to settle, waits until the bot is near the map area, then starts the printer.
- `src/nerv-carpet-printer.js` is the printer core. It mirrors the Java `CarpetPrinter.java` state machine as closely as Mineflayer allows.

The printer states are:

- `Walking`: raw forward movement toward the next checkpoint. No pathfinder is used for the print path.
- `Dumping`: drops inventory stacks the addon would dump before restocking.
- `AwaitRestockResponse`: waits for a material chest window, scans it, and queues full-stack quick-move clicks.
- `AwaitMapChestResponse`: takes one empty map and one glass pane from the map-material chest.
- `AwaitCartographyResponse`: shift-clicks the filled map and glass pane into the cartography table, then quick-moves the locked map output.
- `AwaitFinishedMapChestResponse`: shift-clicks the locked map into the finished-map chest.
- `AwaitResetResponse`: opens the reset chest, waits the configured close delay, then waits for the map area to clear.
- `AwaitAreaClear`: waits until the 128x128 build area is air.
- `AwaitNBTFile`: loads the next top-level `.nbt` from the NERV folder.
- `AwaitBlockBreak`: breaks wrong carpet during repair/reset behavior.

The main tick loop follows the Java addon order:

1. Count allowed placements from `BOT_PLACE_DELAY_MS`.
2. Retry block interaction if a chest/table did not respond.
3. Wait configured timeout ticks.
4. Swap inventory material into hotbar if needed.
5. Quick-move queued restock stacks.
6. Break repair/reset blocks.
7. Dump unwanted inventory.
8. Handle clear/next-map/window responses.
9. Walk and place carpets.

## Carpet Placement Behavior

The placement code intentionally does not call Mineflayer's normal `bot.placeBlock()`, because Mineflayer waits up to 5 seconds for a `blockUpdate`. The Java mod does not wait per block.

Instead, the port:

- Uses `BOT_PRINT_STRATEGY=sealed` by default. This keeps NERV's continuous row movement, but gives urgent priority to any real air cell that is behind the bot or close to leaving place range.
- Falls back to the original closest-cell selector only when `BOT_PRINT_STRATEGY=closest`.
- Selects the needed carpet from configured hotbar slots.
- Sends the place packet immediately through Mineflayer's low-level placement helper.
- Chooses a non-clickable neighboring place side first, matching the addon's patched `BlockUtils.getPlaceSide`. This lets the bot place beside existing carpet instead of sneaking on every dispenser/chest support.
- Uses only real visible neighbor blocks as side references. This avoids sending place packets against a carpet the server has not confirmed yet, which was a major source of fast-row gaps.
- Does not sneak by default. Per-block sneak made 6b6t validate the bot at sneak-walk speed; the fast path now mirrors the addon and side-places instead.
- If a cell can only be placed against a clickable support like a dispenser, the bot sends packet-only sneak for that placement even with `BOT_SNEAK_PLACE=false`. This prevents the server opening the dispenser GUI while keeping normal walk speed.
- Packet-only sneak is also available for all clickable references with `BOT_SNEAK_PLACE=true` if a different server requires it.
- Closes unexpected container windows during placement if a no-sneak fallback hits an interactable block.
- Sends one packet per normal placement by default (`BOT_PLACEMENT_BURST=1`). Sealed urgent retries handle missed packets without blasting 6b6t with three duplicate place packets for every block.
- Caps catch-up bursts with `BOT_MAX_PLACEMENTS_PER_TICK`. If lag builds up hundreds of delayed placements, the bot drops that backlog instead of freezing in place and spamming every missed packet at once.
- Tracks unconfirmed placements in a pending retry queue. In sealed mode, real air wins over optimistic/inflight state once the cell is behind or near the range edge, even if the retry timer has not elapsed yet.
- Pauses or raw-walks back without pathfinder when a missed cell is about to leave range. This is the important anti-gap behavior: the bot is allowed to briefly lose speed, but it should not leave an open strip behind.
- Blocks `lineEnd` checkpoint completion until the active printed strip has no real open planned cells.
- Never abandons a still-air pending hole. Wrong solid carpets can be left for the end repair pass, but empty cells stay in the live retry path.
- Treats water/lava in the carpet layer as replaceable placement targets, which helps after reset water lingers at the map edge.
- Tracks optimistic placements briefly so it does not spam a block while the server update is still arriving.
- If one air cell keeps missing, switches that cell to careful look placement after `BOT_PLACEMENT_CAREFUL_AFTER_ATTEMPTS` retries instead of abandoning the hole.
- Lets line-end path recalculation and repair handle mistakes, like the addon.
- Uses Mineflayer pathfinder only for dump/restock/reset travel. Carpet rows still use the raw forward-walk printer logic.
- Carpet-row checkpoint detection stays tight at `BOT_CHECKPOINT_BUFFER`, but also accepts crossing the checkpoint plane within `BOT_PRINT_CHECKPOINT_SIDE_TOLERANCE`. That keeps Mineflayer from turning back after a tiny overshoot.
- Keeps addon-style `NotPlacing` sprint, but cuts sprinting under `BOT_SPRINT_MIN_FOOD` so the bot does not starve when there is no food in inventory.

Speed is controlled mainly by:

```env
BOT_PRINT_STRATEGY=sealed
BOT_PLACE_DELAY_MS=20
BOT_LINES_PER_RUN=5
BOT_PLACE_RANGE=5
BOT_MIN_PLACE_DISTANCE=0.8
BOT_CHECKPOINT_BUFFER=0.2
BOT_MIN_CHECKPOINT_BUFFER=0.2
BOT_INTERACT_CHECKPOINT_BUFFER=0.85
BOT_PRINT_CHECKPOINT_SIDE_TOLERANCE=1.5
BOT_PLACEMENT_RETRIES=20
BOT_PLACEMENT_RETRY_DELAY_MS=25
BOT_PLACEMENT_PENDING_MS=150
BOT_PLACEMENT_ABANDON_MS=30000
BOT_PLACEMENT_CAREFUL_AFTER_ATTEMPTS=8
BOT_PLACEMENT_BURST=1
BOT_MAX_PLACEMENTS_PER_TICK=4
BOT_SEAL_EDGE_MARGIN=0.35
BOT_SEAL_LOOKBEHIND_BLOCKS=0.75
BOT_SEAL_MOVEMENT_HOLD_BEHIND=0.60
BOT_SEAL_URGENT_BURST=4
BOT_SEAL_MAX_BACKTRACK_BLOCKS=3
BOT_SEAL_LOG_MS=2000
BOT_PLACEMENT_VERIFY_MS=0
BOT_HOTBAR_SETTLE_MS=0
BOT_PACKET_PLACE_LOOK=false
BOT_FAST_PLACEMENT_REFERENCES=true
BOT_PACKET_PRINT_MOVEMENT=false
BOT_PACKET_PRINT_SPEED=5.6
BOT_PACKET_PRINT_MAX_STEP=0.45
BOT_SNEAK_PLACE=false
BOT_PACKET_SNEAK_PLACE=true
BOT_UNSNEAK_WHILE_WALKING=true
BOT_PATHFINDER_FOR_INTERACT_TRAVEL=true
BOT_SPRINT_MIN_FOOD=6
BOT_CLOSE_UNEXPECTED_WINDOWS=true
```

These match the attached Meteor config screenshots: 5 lines per run, 20ms place delay, 5-block range, and 0.2 line checkpoint buffer. The port keeps line checkpoints tight, but uses a slightly larger interact checkpoint buffer for dump/restock/reset spots so Mineflayer does not pin itself against chests while trying to hit an exact decimal coordinate.

The seal settings mean:

- `BOT_SEAL_EDGE_MARGIN`: how close to max place range an open behind cell can get before it becomes urgent.
- `BOT_SEAL_LOOKBEHIND_BLOCKS`: how far behind the bot a real air cell can be before movement pauses.
- `BOT_SEAL_MOVEMENT_HOLD_BEHIND`: extra behind distance before the bot actually pauses; tiny misses are still placed first while walking.
- `BOT_SEAL_URGENT_BURST`: minimum urgent placement attempts per tick while sealing a hole.
- `BOT_SEAL_MAX_BACKTRACK_BLOCKS`: extra scan distance for near-range misses before line end.
- `BOT_SEAL_LOG_MS`: throttle for `Seal hold ...` debug lines.

## Restocking Behavior

Restocking is intentionally strict:

- The bot calculates the next addon capacity window with `getRequiredItems`: upcoming open map cells until the configured inventory slots are full.
- It dumps every available inventory slot that is not useful for that window.
- It rounds each chosen material to full stacks, subtracts kept inventory stacks, then builds `restockList`.
- It routes to the closest registered material chest among the current `restockList`, matching the Java addon.
- The bot opens the registered material chest for the current carpet.
- It scans chest slots in random order.
- It only queues stacks where `count === 64`.
- It quick-moves one queued chest slot per `BOT_INV_ACTION_DELAY_MS`.
- If that chest does not have enough full stacks, it marks the chest checked and walks to the next registered chest for that same material.
- If Mineflayer reports no inventory destination while taking stacks, the active `restockList` is kept and the bot goes back through the dump station.
- The active restock target is frozen for the whole dump/refill cycle. Real air blocks are counted even if an old optimistic place packet says they might be filled.
- Before leaving restock, the bot audits all build slots against the frozen target. If stacks are short or wrong items remain, it dumps/refills again instead of resuming with a bad inventory.

This matches the Java mod. Partial stacks are not used for chest restock, even if they exist in the chest. The port does not protect rare future colors outside the current addon capacity window.

By default `BOT_RESTOCK_SLOT_MODE=full`, so all 36 player inventory slots are considered build slots and non-carpet items in those slots are dumpable. Set `BOT_RESTOCK_SLOT_MODE=addon` to use the original addon slot filter, which only uses empty slots or slots already holding registered carpet materials.

Mineflayer adds two transport guards: restock targets are rounded up to full stacks so the bot fills all usable build slots with carpets, and when placement fails because the bot has zero of the exact carpet it is trying to place, that one material is seeded into the next restock target. This prevents optimistic/pending packet state from hiding the missing color from restock planning. It does not change normal addon `getRequiredItems` order or closest-chest routing.

Useful defaults:

```env
BOT_PRE_RESTOCK_DELAY_MS=500
BOT_RESTOCK_SLOT_MODE=full
BOT_INV_ACTION_DELAY_MS=100
BOT_POST_RESTOCK_DELAY_MS=300
BOT_PRE_SWAP_DELAY_MS=0
BOT_POST_SWAP_DELAY_MS=0
BOT_RETRY_INTERACT_MS=1000
BOT_INTERACT_RECOVERY_CYCLES=2
BOT_RESET_CHEST_CLOSE_DELAY_MS=1000
BOT_CHECKPOINT_BUFFER=0.2
BOT_INTERACT_CHECKPOINT_BUFFER=0.85
BOT_DRAIN_RESET_WATER=true
BOT_WATER_DRAIN_ACTION_DELAY_MS=500
BOT_WATER_DRAIN_VERIFY_MS=1500
BOT_WATER_DRAIN_VERIFY_CHECKS=3
BOT_ANTI_VELOCITY=true
BOT_RESET_VIEW_DISTANCE=12
BOT_RESET_VIEW_BOOST_MS=5000
BOT_RESTART_RECONNECT_QUICK_DELAY_MS=30000
BOT_RESTART_RECONNECT_DELAY_MS=420000
```

## Logs

The terminal hides normal public chat unless `BOT_DEBUG_PRINTS=true` or smoke mode is used. The printer still logs bot-relevant events:

- state changes
- position/progress summaries
- dump decisions
- restock window summaries
- restock target/kept/list route summaries
- exact missing-material restock seeds
- queued restock quick-move slots
- hotbar swaps
- every 64 placement packets sent
- sealed-printer holds/backtracks with `Seal hold ...`
- line-end errors/repair
- dirty-map reset decisions
- stuck reset-water bucket drain attempts
- 6b6t restart/lobby reconnect decisions
- hunger/eating/death recovery
- map finish/reset/next-map flow

If the bot looks stuck, the most important lines are:

- `State -> ...`
- `Progress pos=... checkpoints=...`
- `Restock window ... queued=... remainingStacks=...`
- `Restock target: ...`
- `Restock seeded: ...`
- `Restock kept: ...`
- `Restock route: ...`
- `Quick-moving restock chest slot ...`
- `Swapping inventory slot ... into hotbar slot ...`
- `Placed packets sent: ...`
- `Seal hold ...`

Placement error logs are capped so one bad/dirty map does not flood the terminal:

```env
BOT_ERROR_LOG_LIMIT=25
```

## Preview A Map Plan

```bash
npm run plan -- --map ./maps/my-map.nbt
```

This parses the NBT file, prints required block counts, and shows the first few planned placements without joining Minecraft.

## Preflight The Real Setup

```bash
npm run preflight
```

This checks the configured server/version, selected NERV config, selected NBT map, map corner, and whether every required carpet color has a registered material chest.

## Run One Bot

```bash
npm start
```

The bot starts automatically when `BOT_AUTO_START=true`. If you set `BOT_AUTO_START=false`, join as `BOT_OWNER` and type `!start`.

On spawn, the bot runs the startup sequence before printing:

1. Send `BOT_LOGIN_COMMAND`, when configured.
2. Wait `BOT_POST_LOGIN_WAIT_MS`.
3. Hold forward for `BOT_WALK_AFTER_LOGIN_MS`.
4. Wait until position is sane and within `BOT_WORLD_READY_DISTANCE` of the configured map origin.
5. Start the print, unless `BOT_AUTO_START=false`.

If 6b6t puts the bot in a lobby/menu around `0,0`, the wrapper disconnects and reconnects. If chat announces a restart/backup-server wait, the wrapper disconnects and tries once after `BOT_RESTART_RECONNECT_QUICK_DELAY_MS` (`30000` ms), then uses `BOT_RESTART_RECONNECT_DELAY_MS` (`420000` ms) if it still is not ready.

After the reset chest runs, the bot checks for stuck water sources on the map layer. When `BOT_DRAIN_RESET_WATER=true`, any `water` block with a `dispenser` directly underneath is handled like the manual process: open dispenser, take an empty bucket, drain the source, store the bucket back, then re-check the reset area. If the bot inventory is full, it dumps one carpet stack to make bucket room.

During reset/water work, `BOT_ANTI_VELOCITY=true` zeros bot knockback/explosion velocity like Meteor Velocity. Startup/preflight logs show whether it is on, and runtime logs print `antiVelocity cancels=N` when velocity packets are being cancelled. Reset also temporarily raises client view distance to `BOT_RESET_VIEW_DISTANCE` while walking to the platform center, then restores the normal value after `BOT_RESET_VIEW_BOOST_MS`.

Before the bot locks/stores a map, it performs one strict real-world finish scan. If any planned carpet cell is still open, it rebuilds the print path and continues instead of moving the `.nbt` file to `_finished_maps`.

For the current 6b6t setup, the normal command is:

```bash
cd "/Users/aravsharma/Documents/MAp Bot/mineflayer-port"
npm run preflight
npm start
```

`preflight` should show:

- server `play.6b6t.org:25565`
- username `CostcoBot`
- auth `offline`
- loaded NERV config path
- selected top-level `.nbt`
- 16 material chest colors loaded
- material chest coverage `ok`

## Smoke Test 6b6t Login/Portal

```bash
npm run smoke
```

Smoke mode logs in, walks through the 6b6t cracked-account portal, accepts resource packs, logs transfer/configuration packets, and idles without printing.

## Troubleshooting

If it keeps searching chests for one carpet color, stock that material chest with full stacks. The Java mod ignores partial stacks for restock.

If the map area still contains an older map, the bot resets instead of trying to repair thousands of wrong carpets. That recovery limit is:

```env
BOT_RESET_DIRTY_MAP_ERROR_LIMIT=64
```

Set it to `0` to disable dirty-map auto-reset and use pure Java `error-action` behavior.

If it never reaches a checkpoint, confirm the configured `openPos` and `mapCorner` in the NERV config are still correct for the server build.

If it places too slowly, check that the code is using `_genericPlace` and not `bot.placeBlock()`. `bot.placeBlock()` waits for block updates and is too slow for this printer.

If it disconnects during a transfer/configuration packet, the wrapper reconnects after `BOT_RECONNECT_DELAY_MS`. If 6b6t says the account is already online, it waits `BOT_ONLINE_RETRY_DELAY_MS`.

If it is starving, put food in the bot inventory. The wrapper pauses printing, eats any normal Minecraft food it can find when food drops below `BOT_EAT_FOOD_THRESHOLD`, then resumes. If it dies anyway, it respawns and reconnects so startup/world-ready logic runs again.
