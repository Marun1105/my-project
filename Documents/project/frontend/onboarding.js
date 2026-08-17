// onboarding.js — кратко представяне при първо отваряне: какво прави всеки раздел.
// Показва се веднъж; изборът се пази локално и не зависи от акаунт.
const Onboarding = (() => {
  const $ = id => document.getElementById(id);
  const SEEN_KEY = 'climby-onboarding-seen';
  const STEPS = [
    { icon: '📚', title: 'onboarding.t1', body: 'onboarding.b1' },
    { icon: '✅', title: 'onboarding.t2', body: 'onboarding.b2' },
    { icon: '🎯', title: 'onboarding.t3', body: 'onboarding.b3' },
  ];

  let index = 0;

  function render() {
    const step = STEPS[index];
    $('onboardingIcon').textContent = step.icon;
    $('onboardingTitle').textContent = t(step.title);
    $('onboardingBody').textContent = t(step.body);
    $('onboardingNext').textContent = index === STEPS.length - 1 ? t('onboarding.start') : t('onboarding.next');
    document.querySelectorAll('.onboarding-dot').forEach((d, i) => {
      d.classList.toggle('active', i === index);
    });
  }

  function finish() {
    localStorage.setItem(SEEN_KEY, '1');
    $('onboarding').classList.add('hidden');
  }

  function next() {
    if (index === STEPS.length - 1) { finish(); return; }
    index++;
    render();
  }

  function maybeShow() {
    if (localStorage.getItem(SEEN_KEY) === '1') return;
    index = 0;
    render();
    $('onboarding').classList.remove('hidden');
  }

  function init() {
    $('onboardingNext').addEventListener('click', next);
    $('onboardingSkip').addEventListener('click', finish);
    window.addEventListener('climby:lang-changed', () => {
      if (!$('onboarding').classList.contains('hidden')) render();
    });
    // Показваме го чак след входната бариера — иначе двата слоя се застъпват.
    // Слушаме събитието за случая, когато бариерата се затвори по-късно, НО и
    // проверяваме състоянието веднага: auth.js се инициализира преди този файл и
    // събитието вече може да е минало, преди да сме се закачили за него.
    window.addEventListener('climby:entry-gate-closed', maybeShow);
    if ($('entryGate').classList.contains('hidden')) maybeShow();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', Onboarding.init);
