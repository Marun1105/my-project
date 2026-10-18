(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FaceVerification = api;
})(typeof globalThis === 'object' ? globalThis : window, function () {
  function distance(a, b) {
    if (!a || !b || a.length !== b.length || !a.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum);
  }

  function average(descriptors) {
    if (!descriptors.length || descriptors.some(d => !d || d.length !== descriptors[0].length)) return null;
    const result = new Float32Array(descriptors[0].length);
    for (const descriptor of descriptors) {
      for (let i = 0; i < descriptor.length; i++) result[i] += descriptor[i] / descriptors.length;
    }
    return result;
  }

  // The usual same-person distance for this model. Stricter than this, a
  // student's own face turned a little on a 320x240 camera "did not match".
  const DEFAULT_THRESHOLD = 0.6;

  function matches(reference, candidate, threshold = DEFAULT_THRESHOLD) {
    return distance(reference, candidate) <= threshold;
  }

  // While a session runs. `candidate` is a descriptor of a face seen clearly,
  // or null when no face was seen clearly. Null is not evidence of anything —
  // the student looking down at the notebook, turning away, a dark frame — so
  // it neither counts towards a pause nor resets the count. Only a clear,
  // different face does, `consecutiveMisses` times in a row.
  function createMonitor(reference, threshold = DEFAULT_THRESHOLD, consecutiveMisses = 5) {
    let misses = 0;
    return Object.freeze({
      observe(candidate) {
        if (!candidate) return Object.freeze({ matched: null, shouldPause: misses >= consecutiveMisses });
        const matched = matches(reference, candidate, threshold);
        misses = matched ? 0 : misses + 1;
        return Object.freeze({ matched, shouldPause: misses >= consecutiveMisses });
      },
    });
  }

  // While paused. True once the face that started the session has been seen
  // `needed` times in a row, so the session resumes by itself instead of
  // waiting for a button that needed one perfect frame.
  function createResumeWatch(reference, threshold = DEFAULT_THRESHOLD, needed = 2) {
    let streak = 0;
    return Object.freeze({
      observe(candidate) {
        streak = candidate && matches(reference, candidate, threshold) ? streak + 1 : 0;
        return streak >= needed;
      },
    });
  }

  return Object.freeze({ DEFAULT_THRESHOLD, average, createMonitor, createResumeWatch, distance, matches });
});
