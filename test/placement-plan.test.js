const assert = require('node:assert/strict');
const test = require('node:test');
const { makePlacementPlan } = require('../src/placement-plan');

test('makePlacementPlan uses north/south zig-zag line order', () => {
  const cells = Array.from({ length: 2 }, () => Array.from({ length: 3 }, () => null));
  cells[0][0] = 'red_carpet';
  cells[0][2] = 'blue_carpet';
  cells[1][0] = 'green_carpet';
  cells[1][2] = 'yellow_carpet';

  const plan = makePlacementPlan(
    { width: 2, depth: 3, cells },
    { x: 100, y: 64, z: 200 }
  );

  assert.deepEqual(
    plan.map((placement) => [placement.blockName, placement.position]),
    [
      ['red_carpet', { x: 100, y: 64, z: 200 }],
      ['blue_carpet', { x: 100, y: 64, z: 202 }],
      ['yellow_carpet', { x: 101, y: 64, z: 202 }],
      ['green_carpet', { x: 101, y: 64, z: 200 }]
    ]
  );
});
