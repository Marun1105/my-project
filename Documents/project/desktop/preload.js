// preload.js — единственият мост между приложението и страницата.
// Нарочно е почти празен: страницата няма нужда от Node, а колкото по-малко
// ѝ даваме, толкова по-малко може да се обърка. Флагът служи, за да може
// интерфейсът да се държи различно на компютър (напр. да не предлага
// "инсталирай като приложение", когато вече е приложение).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('CLIMBY_DESKTOP', {
  isDesktop: true,
  platform: process.platform,
  // Викa се веднъж от auth.js. Страницата не получава самия ipcRenderer —
  // получава една функция и нищо друго, което да обърка.
  onSignIn: handler => ipcRenderer.on('climby:auth-token', (_event, payload) => handler(payload)),
  // The menu bar is hidden, so Help → About and Help → Check for Updates are
  // invisible to anyone who doesn't press Alt. Settings shows them instead.
  version: () => ipcRenderer.invoke('climby:version'),
  checkForUpdates: () => ipcRenderer.invoke('climby:check-updates'),
  // A Windows notification: a title and a line, nothing more (see main.js).
  notify: payload => ipcRenderer.invoke('climby:notify', payload),
  onNotificationClick: handler => ipcRenderer.on('climby:notification-click', (_event, tag) => handler(tag)),
  onUpdateStatus: handler => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on('climby:update-status', listener);
    return () => ipcRenderer.removeListener('climby:update-status', listener);
  },
});
