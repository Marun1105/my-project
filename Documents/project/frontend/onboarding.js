// onboarding.js — кратък въпросник при първо отваряне, после представяне на
// разделите. Първо питаме кой е човекът и откъде е чул за Climby: отговорите
// стоят локално, докато не се стигне до регистрация, и тогава пътуват с нея.
// Никой не е длъжен да отговори — "Пропусни" затваря всичко.
const Onboarding = (() => {
  const $ = id => document.getElementById(id);
  const SEEN_KEY = 'climby-onboarding-seen';
  const ROLE_KEY = 'climby-quiz-role';
  const HEARD_KEY = 'climby-quiz-heard';

  // Иконките са начертани, а не емоджи. Първият екран на новия човек е точно
  // мястото, където приложението показва какво е: емоджито идва оцветено от
  // операционната система в интерфейс, който нарочно е черно-бял, и изглежда
  // различно на всеки телефон.
  const ICON_PATHS = {
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.2 8.8-2 5.4-5.4 2 2-5.4z"/>',
    hello: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3.2"/>',
    book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8.2 12.3 2.6 2.6 5-5.2"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
  };

  function iconSvg(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + (ICON_PATHS[name] || '') + '</svg>';
  }

  const STEPS = [
    {
      key: ROLE_KEY,
      icon: 'compass',
      title: 'quiz.roleTitle',
      body: 'quiz.roleBody',
      choices: [
        ['student', 'quiz.student'],
        ['parent', 'quiz.parent'],
        ['teacher', 'quiz.teacher'],
      ],
    },
    {
      key: HEARD_KEY,
      icon: 'hello',
      title: 'quiz.heardTitle',
      body: 'quiz.heardBody',
      choices: [
        ['friend', 'quiz.friend'],
        ['teacher', 'quiz.fromTeacher'],
        ['parent', 'quiz.fromParent'],
        ['school', 'quiz.school'],
        ['social', 'quiz.social'],
        ['search', 'quiz.search'],
        ['other', 'quiz.other'],
      ],
    },
    { icon: 'book', title: 'onboarding.t1', body: 'onboarding.b1' },
    { icon: 'check', title: 'onboarding.t2', body: 'onboarding.b2' },
    { icon: 'target', title: 'onboarding.t3', body: 'onboarding.b3' },
  ];

  let index = 0;

  function render() {
    const step = STEPS[index];
    $('onboardingIcon').innerHTML = iconSvg(step.icon);
    $('onboardingTitle').textContent = t(step.title);
    $('onboardingBody').textContent = t(step.body);

    // Точките се рисуват от кода — стъпките вече не са фиксирано три.
    const dots = $('onboardingSteps');
    if (dots && dots.children.length !== STEPS.length) {
      dots.innerHTML = '';
      STEPS.forEach(() => {
        const d = document.createElement('span');
        d.className = 'onboarding-dot';
        dots.appendChild(d);
      });
    }
    if (dots) [...dots.children].forEach((d, i) => d.classList.toggle('active', i === index));

    const box = $('onboardingChoices');
    const next = $('onboardingNext');
    box.innerHTML = '';
    if (step.choices) {
      // На въпрос отговаряш с натискане на отговор — "Напред" би бил втори начин
      // да не отговориш, а за това вече има "Пропусни".
      box.classList.remove('hidden');
      next.classList.add('hidden');
      for (const [value, key] of step.choices) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'onboarding-choice';
        b.textContent = t(key);
        b.addEventListener('click', () => {
          try { localStorage.setItem(step.key, value); } catch { /* без запис също върви */ }
          advance();
        });
        box.appendChild(b);
      }
    } else {
      box.classList.add('hidden');
      next.classList.remove('hidden');
      next.textContent = index === STEPS.length - 1 ? t('onboarding.start') : t('onboarding.next');
    }
  }

  function finish() {
    localStorage.setItem(SEEN_KEY, '1');
    $('onboarding').classList.add('hidden');
  }

  function advance() {
    if (index === STEPS.length - 1) { finish(); return; }
    index++;
    render();
  }

  function next() { advance(); }

  function maybeShow() {
    if (localStorage.getItem(SEEN_KEY) === '1') return;
    index = 0;
    render();
    $('onboarding').classList.remove('hidden');
  }

  function init() {
    $('onboardingNext').addEventListener('click', next);
    $('onboardingSkip').addEventListener('click', finish);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('onboarding').classList.contains('hidden')) finish();
    });
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
