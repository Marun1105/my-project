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
});
