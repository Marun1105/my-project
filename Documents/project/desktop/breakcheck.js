// breakcheck.js — the break reminder's rules, without a clock to wait for.
//
//   npm run breakcheck
const assert = require('node:assert/strict');
const B = require('../frontend/break-schedule.js');

const at = h => new Date(2026, 9, 18, h, 30);
// by the time of day, between 30 and 45 minutes
assert.equal(B.bucket(7), 'morning');
assert.equal(B.bucket(11), 'morning');
assert.equal(B.bucket(12), 'afternoon');
assert.equal(B.bucket(17), 'afternoon');
assert.equal(B.bucket(18), 'evening');
assert.equal(B.bucket(20), 'evening');
assert.equal(B.bucket(21), 'late');
assert.equal(B.bucket(2), 'late');
assert.equal(B.bucket(4), 'late');
assert.equal(B.intervalMs(at(9)), 45 * B.MINUTE);
assert.equal(B.intervalMs(at(15)), 40 * B.MINUTE);
assert.equal(B.intervalMs(at(19)), 35 * B.MINUTE);
assert.equal(B.intervalMs(at(23)), 30 * B.MINUTE);
for (let h = 0; h < 24; h++) {
  const m = B.intervalMs(at(h)) / B.MINUTE;
  assert.ok(m >= 30 && m <= 45, `hour ${h}: ${m} min`);
}

// five minutes, ten after an hour and a half of study
assert.equal(B.breakMs(30 * B.MINUTE), 5 * B.MINUTE);
assert.equal(B.breakMs(89 * B.MINUTE), 5 * B.MINUTE);
assert.equal(B.breakMs(90 * B.MINUTE), 10 * B.MINUTE);

// never the same line twice in a row, and every line can come up
for (let last = 0; last < 6; last++) {
  const seen = new Set();
  for (let r = 0; r < 1; r += 0.01) {
    const i = B.pickLine(6, last, () => r);
    assert.notEqual(i, last);
    assert.ok(i >= 0 && i < 6);
    seen.add(i);
  }
  assert.equal(seen.size, 5, `after line ${last} the other five all appear`);
}
const first = new Set();
for (let r = 0; r < 1; r += 0.01) first.add(B.pickLine(6, null, () => r));
assert.equal(first.size, 6, 'the first line can be any of the six');

console.log('break schedule checks passed');
