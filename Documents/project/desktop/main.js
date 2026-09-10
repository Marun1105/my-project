// main.js — Climby като истинско приложение за компютър (Electron).
//
// Интерфейсът е същият като в frontend/, но не се отваря в раздел на браузъра:
// има свой прозорец, своя икона в лентата на задачите и се стартира от менюто "Старт".
// Сървърът (Render) остава същият, за да може ученикът да влезе в акаунта си и от
// телефон, и от компютър и да вижда същия чеклист.
const { app, BrowserWindow, Menu, dialog, protocol, net, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { initAutoUpdate, checkForUpdatesManually } = require('./updater');

// Страницата се зарежда през собствена схема app://, а не през file://.
// Причината е камерата: getUserMedia работи само в "сигурен контекст". Затова
// схемата се обявява за secure — иначе скенерът и Фокус камерата няма да тръгнат.
// standard: true дава истински произход (app://climby), какъвто localStorage изисква.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      allowServiceWorkers: true,
      stream: true,
    },
  },
]);

// При разработка четем направо от frontend/; в опакования вид файловете стоят в resources/.
const FRONTEND_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'frontend')
  : path.join(__dirname, '..', 'frontend');

function _resolveInsideFrontend(urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const target = path.join(FRONTEND_DIR, rel === '' ? 'index.html' : rel);
  // Заявка като app://climby/../../secrets не бива да излиза извън папката.
  const inside = path.relative(FRONTEND_DIR, target);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return target;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    // Същият почти черен фон като на тъмната тема — иначе прозорецът мига в бяло,
    // докато страницата се зарежда.
    backgroundColor: '#0a0a0a',
    title: 'Climby',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL('app://climby/index.html');

  // Външните връзки отиват в браузъра по подразбиране, а не отварят втори прозорец
  // на приложението без адресна лента.
  //
  // Но НЕ всяка връзка: shell.openExternal подава адреса на Windows, а Windows
  // отваря с каквото знае — file:// пуска програма от диска, ms-msdt: и search-ms:
  // са си отделна история. Отговорът на AI учителя е чужд текст, който идва по
  // мрежата; DOMPurify маха javascript:, но file: не е негова работа, а и кликът
  // върху връзка изобщо не минава през него. Затова навън пускаме само това, което
  // наистина е страница в интернет, а всичко останало се преглъща мълчаливо.
  const EXTERNAL_OK = new Set(['https:', 'http:', 'mailto:']);
  const openExternally = url => {
    let protocol;
    try {
      protocol = new URL(url).protocol;
    } catch {
      return; // неразбираем адрес — няма къде да го отворим
    }
    if (EXTERNAL_OK.has(protocol)) shell.openExternal(url);
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://')) {
      event.preventDefault();
      openExternally(url);
    }
  });

  return win;
}

// Без меню Ctrl+C / Ctrl+V не работят в полетата за писане на Windows, затова
// менюто е малко, но има нужните роли.
function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [{ role: 'quit', label: 'Quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'resetZoom', label: 'Actual Size' },
        { role: 'zoomIn', label: 'Zoom In' },
        { role: 'zoomOut', label: 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Full Screen' },
        { role: 'toggleDevTools', label: 'Developer Tools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for Updates', click: () => checkForUpdatesManually() },
        { type: 'separator' },
        {
          label: 'About Climby',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              buttons: ['OK'],
              title: 'Climby',
              message: `Climby ${app.getVersion()}`,
              detail: 'Climb your way to success.',
            }),
        },
      ],
    },
  ]);
}

// Второ стартиране да не отваря втори прозорец, а да показва вече отворения.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow = null;

  // Windows подава climby:// връзка на програмата, която е заявила схемата.
  // Инсталаторът записва заявката; това тук покрива пускането при разработка,
  // където инсталатор няма, и поправя записа, ако друга програма го е взела.
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('climby', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('climby');
  }

  function forwardSignIn(rawUrl) {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return; // неразбираем адрес не е вход
    }
    // climby://auth?t=... — hostname е "auth". Само този адрес значи нещо тук.
    if (parsed.hostname !== 'auth') return;
    const token = parsed.searchParams.get('t');
    if (!token || !mainWindow) return;
    // nonce-ът се подава нататък непроверен НАРОЧНО: тук няма как да се провери.
    // Стойността я е измислила страницата и само тя знае коя е — обвивката просто
    // я пренася. Проверката е в auth.js, където живее очакваната стойност.
    mainWindow.webContents.send('climby:auth-token', {
      token,
      isNew: parsed.searchParams.get('new') === '1',
      nonce: parsed.searchParams.get('n') || '',
    });
  }

  // climby:// връзка пуска ВТОРО копие на приложението, което ключалката за едно
  // копие затваря веднага — но Windows първо подава адреса на това копие, а той
  // пристига тук, в работещото. Без този ред връзката само вдига прозореца и
  // губи токена мълчаливо.
  app.on('second-instance', (event, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const deepLink = (argv || []).find(arg => typeof arg === 'string' && arg.startsWith('climby://'));
    if (deepLink) forwardSignIn(deepLink);
  });

  // macOS подава адреса като събитие, а не като аргумент. Евтино е да се поддържа
  // и грешно е да се пропусне.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    forwardSignIn(url);
  });

  app.whenReady().then(() => {
    // Content-Security-Policy нарочно не се слага тук с onHeadersReceived: същата
    // страница върви и в браузър, и като инсталирано уеб приложение, където Electron
    // го няма. Правилото стои в <meta> в index.html, за да важи и за трите случая и
    // да не се разминават две копия. Ако някой ден потрябва по-строго правило само за
    // компютърната версия, то се добавя тук — но остава допълнение, а не замяна.
    protocol.handle('app', request => {
      const target = _resolveInsideFrontend(new URL(request.url).pathname);
      if (!target) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).toString());
    });

    // Приложението иска само камера (скенер и Фокус). Всичко останало се отказва,
    // за да не може страница да поиска местоположение, известия и т.н.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media');
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

    Menu.setApplicationMenu(buildMenu());
    mainWindow = createWindow();

    // Проверката за нова версия тръгва след като прозорецът е вече на екрана.
    initAutoUpdate(() => mainWindow);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
