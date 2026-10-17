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

  function matches(reference, candidate, threshold = 0.55) {
    return distance(reference, candidate) <= threshold;
  }

  function createMonitor(reference, threshold = 0.55, consecutiveMisses = 3) {
    let misses = 0;
    return Object.freeze({
      observe(candidate) {
        const matched = matches(reference, candidate, threshold);
        misses = matched ? 0 : misses + 1;
        return Object.freeze({ matched, shouldPause: misses >= consecutiveMisses });
      },
    });
  }

  return Object.freeze({ average, createMonitor, distance, matches });
});
