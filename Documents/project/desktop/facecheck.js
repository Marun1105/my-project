const assert = require('node:assert/strict');
const FaceVerification = require('../frontend/face-verification.js');

assert.equal(FaceVerification.distance([0, 0], [0.3, 0.4]), 0.5);
assert.equal(FaceVerification.distance([0], [0, 0]), Infinity);
assert.deepEqual(FaceVerification.average([[0, 2], [2, 4]]), new Float32Array([1, 3]));
assert.equal(FaceVerification.average([[0], [0, 1]]), null);
assert.equal(FaceVerification.matches([0, 0], [0.3, 0.4], 0.5), true);
assert.equal(FaceVerification.matches([0], [1], 0.5), false);

const monitor = FaceVerification.createMonitor([0], 0.5, 3);
assert.deepEqual(monitor.observe([1]), { matched: false, shouldPause: false });
assert.deepEqual(monitor.observe(null), { matched: false, shouldPause: false });
assert.deepEqual(monitor.observe([0]), { matched: true, shouldPause: false });
assert.deepEqual(monitor.observe([1]), { matched: false, shouldPause: false });
assert.deepEqual(monitor.observe([1]), { matched: false, shouldPause: false });
assert.deepEqual(monitor.observe([1]), { matched: false, shouldPause: true });

console.log('face verification checks passed');
