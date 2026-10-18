// shots-data.js — the stand-in backend for shots.js.
//
// Screenshotting an app with no data photographs its empty states, and judging
// a layout by them is how you end up "fixing" space that real content fills.
// This answers the endpoints the screens actually call, with a plausible
// Tuesday for a student in the eighth grade.
const TODAY = new Date();
const day = (n) => {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const TASKS = [
  { id: 't5', text: 'Да довърша чертежа', subject: 'Геометрия', deadline: day(-2), done: false },
  { id: 't1', text: 'Задачи 4–8, стр. 32', subject: 'Математика', deadline: day(0), done: false },
  { id: 't2', text: 'Да повторя за контролното по биология', subject: 'Биология', deadline: day(1), done: false },
  { id: 't3', text: 'Да прочета трета глава', subject: 'История', deadline: day(2), done: false },
  { id: 't4', text: 'Упражнение 5 — неправилни глаголи', subject: 'Английски', deadline: day(3), done: false },
  { id: 't6', text: 'Да науча стихотворението', subject: 'Литература', deadline: day(-5), done: true, created_at: day(-8) + 'T10:00:00Z', completed_at: day(-6) + 'T18:00:00Z' },
];

const EVENTS = [
  { kind: 'solved', at: day(0), text: 'Стигна сам до стъпката', subject: 'Математика' },
  { kind: 'question', at: day(0), text: 'Защо двата ъгъла са равни?', subject: 'Геометрия' },
  { kind: 'focus', at: day(-1), minutes: 35 },
  { kind: 'question', at: day(-1), text: 'Как се дели на дроби?', subject: 'Математика' },
];

const HISTORY = [
  { id: 'h1', question: 'Защо сборът на ъглите е 180°?', answer: 'Прекарай права през върха, успоредна на срещуположната страна…', created_at: day(0), subject: 'Геометрия' },
  { id: 'h2', question: 'Как се съкращава дроб?', answer: 'Търсиш общ делител на числителя и знаменателя…', created_at: day(-1), subject: 'Математика' },
];

module.exports = function answer(pathname) {
  if (pathname.startsWith('/tasks')) return TASKS;
  if (pathname.startsWith('/activity')) return { events: EVENTS, streak: 4, solved_total: 12 };
  if (pathname.startsWith('/history')) return { items: HISTORY };
  if (pathname.startsWith('/focus')) return { sessions: [{ at: day(-1), minutes: 35 }, { at: day(-2), minutes: 50 }], total_minutes: 85 };
  if (pathname.startsWith('/classes')) return { classes: [] };
  if (pathname.startsWith('/family')) return { members: [] };
  if (pathname.startsWith('/usage')) return { calls: 3, cap: 40 };
  return {};
};
