// Сценарий: полный обзор находит 2 устройства, быстрый опрос видит одно, затем быстрый опрос падает.
const path = require('path');
const { app, BrowserWindow } = require('electron');
process.argv.push('--show');
require(path.join(__dirname, '..', 'main.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const wc = () => BrowserWindow.getAllWindows()[0].webContents;
  const rows = async (label) => console.log(label.padEnd(34), await wc().executeJavaScript(
    'Array.from(document.querySelectorAll(".row")).map(r => r.innerText.replace(/\\n+/g," | ")).join("  ##  ")'));
  const click = () => wc().executeJavaScript('document.getElementById("btnRefresh").click()');
  await wait(3000);
  await rows('1. после полного обзора:');
  await click(); await wait(2500);
  await rows('2. быстрый опрос, ответило одно:');
  await click(); await wait(2500);
  await rows('3. быстрый опрос упал (ok:false):');
  app.exit(0);
});
