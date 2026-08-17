// updater.js — как Climby се обновява сам.
//
// Приложението вече стои инсталирано по чужди компютри и никой няма да го сваля
// наново при всяка поправка. Затова при пускане пита GitHub Releases има ли
// по-нова версия, сваля я тихо на заден план и чак когато е готова пита дали да
// рестартира. Ако няма интернет или нещо се счупи — мълчи и не пречи: домашното
// е по-важно от обновяването.
//
// Свалянето е "разлика" (differential): electron-builder качва и .blockmap файл,
// така че второто обновяване тегли няколко мегабайта, а не цялото приложение.
const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

// Докато приложението стои отворено по цял ден, проверяваме пак от време на време.
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // 6 часа
// Първата проверка не е веднага — прозорецът първо трябва да се покаже.
const FIRST_CHECK_DELAY_MS = 8000;

// Преносимият (portable) вариант е един .exe, който потребителят си е сложил
// някъде сам — няма какво да се "инсталира" върху него, затова там не пипаме нищо.
const IS_PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);

let started = false;
let manualCheck = false;
let promptShown = false;
let timer = null;
let getWindow = () => null;

function liveWindow() {
  const win = getWindow();
  return win && !win.isDestroyed() ? win : null;
}

function say(options) {
  const win = liveWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

function info(message, detail) {
  say({ type: 'info', buttons: ['Добре'], title: 'Climby', message, detail });
}

function check() {
  autoUpdater.checkForUpdates().catch(err => {
    // checkForUpdates отхвърля промиса И вдига 'error'; хващаме го тук само за
    // да не остане необработен.
    console.warn('[updater] проверката не мина:', err && err.message ? err.message : err);
  });
}

// Пуска се веднъж, при стартиране. getWindowFn връща главния прозорец (или null),
// за да могат съобщенията да се закачат за него.
function initAutoUpdate(getWindowFn) {
  getWindow = getWindowFn;
  if (started) return;
  started = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', err => {
    console.warn('[updater] грешка:', err && err.message ? err.message : err);
    if (manualCheck) {
      manualCheck = false;
      info(
        'Не успях да проверя за обновяване.',
        'Провери дали има интернет и опитай пак по-късно. Climby работи и така.'
      );
    }
  });

  autoUpdater.on('update-not-available', () => {
    if (manualCheck) {
      manualCheck = false;
      info('Climby е с последната версия.', `Инсталирана версия: ${app.getVersion()}`);
    }
  });

  autoUpdater.on('update-available', info_ => {
    if (manualCheck) {
      manualCheck = false;
      info(
        `Има нова версия: ${info_.version}.`,
        'Свалям я на заден план. Ще ти кажа, когато е готова — дотогава спокойно продължавай да работиш.'
      );
    }
  });

  autoUpdater.on('update-downloaded', async info_ => {
    // Ако ученикът е избрал "По-късно", не го питаме пак при всяка проверка.
    if (promptShown) return;
    promptShown = true;
    const { response } = await say({
      type: 'info',
      buttons: ['Рестартирай сега', 'По-късно'],
      defaultId: 0,
      cancelId: 1,
      title: 'Climby',
      message: `Готова е нова версия на Climby (${info_.version}).`,
      detail:
        'Ако избереш „По-късно“, обновяването ще се сложи само, когато затвориш приложението.',
    });
    if (response === 0) {
      // Извън обработчика на събитието — иначе NSIS понякога не тръгва.
      setImmediate(() => autoUpdater.quitAndInstall());
    }
  });

  // В разработка няма инсталатор, а electron-updater би търсил dev-app-update.yml.
  if (!app.isPackaged || IS_PORTABLE) return;

  setTimeout(check, FIRST_CHECK_DELAY_MS);
  timer = setInterval(check, CHECK_EVERY_MS);
  app.on('before-quit', () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
}

// От менюто "Помощ" → "Провери за обновяване". За разлика от автоматичната
// проверка тази винаги отговаря нещо, дори когато няма нищо ново.
function checkForUpdatesManually() {
  if (!app.isPackaged) {
    info('Проверката работи само в инсталираното приложение.', `Версия: ${app.getVersion()}`);
    return;
  }
  if (IS_PORTABLE) {
    info(
      'Преносимият вариант не се обновява сам.',
      'Изтегли новия „Climby Setup“ от страницата с версиите, за да получаваш обновяванията автоматично.'
    );
    return;
  }
  manualCheck = true;
  check();
}

module.exports = { initAutoUpdate, checkForUpdatesManually };
