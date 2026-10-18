// break-schedule.js — when to suggest a break, and which line to say.
//
// Pure rules, no screen: breaks.js does the showing, desktop/breakcheck.js the
// testing. The owner's rule is "different breaks by the time of the day, around
// 30–45 minutes", by the clock where the student is.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BreakSchedule = api;
})(typeof globalThis === 'object' ? globalThis : window, function () {
  const MINUTE = 60 * 1000;

  // Fresh in the morning, tired by night: the later it is, the sooner a break.
  //   05–12 morning    45 min
  //   12–18 afternoon  40 min   (after school, the long stretch)
  //   18–21 evening    35 min
  //   21–05 late       30 min   (and the lines start hinting at bed)
  function bucket(hour) {
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 18) return 'afternoon';
    if (hour >= 18 && hour < 21) return 'evening';
    return 'late';
  }

  const INTERVAL_MIN = { morning: 45, afternoon: 40, evening: 35, late: 30 };

  function intervalMs(date) {
    return INTERVAL_MIN[bucket(date.getHours())] * MINUTE;
  }

  // Five minutes; ten once the student has put in an hour and a half.
  function breakMs(studiedMs) {
    return (studiedMs >= 90 * MINUTE ? 10 : 5) * MINUTE;
  }

  const SNOOZE_MS = 10 * MINUTE;
  const LINES_PER_BUCKET = 6;
  const OVER_LINES = 4;

  // A line index for the bucket, never the same as the last one shown.
  // `random` is injectable so the rule can be tested.
  function pickLine(count, last, random = Math.random) {
    if (count <= 1) return 0;
    if (last == null) return Math.min(Math.floor(random() * count), count - 1);
    let i = Math.floor(random() * (count - 1));
    if (last != null && i >= last) i += 1;   // skip over the last one
    return Math.min(i, count - 1);
  }

  return Object.freeze({
    MINUTE, SNOOZE_MS, LINES_PER_BUCKET, OVER_LINES,
    bucket, intervalMs, breakMs, pickLine,
  });
});
