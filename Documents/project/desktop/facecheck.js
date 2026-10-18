// facecheck.js — the Focus face check's decision rules, without a camera.
//
//   npm run facecheck
const assert = require('node:assert/strict');
const FaceVerification = require('../frontend/face-verification.js');

assert.equal(FaceVerification.distance([0, 0], [0.3, 0.4]), 0.5);
assert.equal(FaceVerification.distance([0], [0, 0]), Infinity);
assert.deepEqual(FaceVerification.average([[0, 2], [2, 4]]), new Float32Array([1, 3]));
assert.equal(FaceVerification.average([[0], [0, 1]]), null);
assert.equal(FaceVerification.matches([0, 0], [0.3, 0.4], 0.5), true);
assert.equal(FaceVerification.matches([0], [1], 0.5), false);

// The standard same-person distance for this model, not a stricter one: at
// 0.55 a student's own face, turned a little on a 320x240 camera, "did not match".
assert.equal(FaceVerification.DEFAULT_THRESHOLD, 0.6);

// ---- while the session runs ----
{
  const monitor = FaceVerification.createMonitor([0], 0.5, 3);
  // No face is not a different face. Looking down at the notebook, turning
  // away, a dark frame: none of it is evidence that someone else sat down,
  // and it used to pause the session after three seconds.
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(monitor.observe(null), { matched: null, shouldPause: false });
  }
  // Only a face that is clearly there and clearly someone else counts,
  // and only enough of them in a row.
  assert.deepEqual(monitor.observe([1]), { matched: false, shouldPause: false });
  assert.deepEqual(monitor.observe(null), { matched: null, shouldPause: false });   // a gap neither counts nor resets
  assert.deepEqual(monitor.observe([1]), { matched: false, shouldPause: false });
  assert.deepEqual(monitor.observe([0]), { matched: true, shouldPause: false });    // the owner resets the count
  assert.deepEqual(monitor.observe([1]), { matched: false, shouldPause: false });
  assert.deepEqual(monitor.observe([1]), { matched: false, shouldPause: false });
  assert.deepEqual(monitor.observe([1]), { matched: false, shouldPause: true });
}
{
  // the app's own default: five clear mismatches in a row
  const monitor = FaceVerification.createMonitor([0]);
  for (let i = 0; i < 4; i++) assert.equal(monitor.observe([1]).shouldPause, false);
  assert.equal(monitor.observe([1]).shouldPause, true);
}

// ---- while paused: resume by itself once the owner is back ----
{
  const watch = FaceVerification.createResumeWatch([0], 0.5, 2);
  assert.equal(watch.observe(null), false);
  assert.equal(watch.observe([0]), false);   // one match is not enough
  assert.equal(watch.observe(null), false);  // and a gap starts over
  assert.equal(watch.observe([0]), false);
  assert.equal(watch.observe([1]), false);   // someone else starts over too
  assert.equal(watch.observe([0]), false);
  assert.equal(watch.observe([0]), true);    // two in a row: resume
}

console.log('face verification checks passed');
