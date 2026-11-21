// Дымовой тест: electron scripts/smoke.js  (под xvfb)
// Запускает приложение, подставляет вместо navigator.hid подставные устройства и снимает скриншот.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

process.argv.push('--show');
const out = process.env.SMOKE_OUT || '/tmp/smoke';
fs.mkdirSync(out, { recursive: true });

app.on('browser-window-created', (_e, w) => {
  w.webContents.on('console-message', (_ev, level, message) => console.log(`[renderer:${level}] ${message}`));
  w.webContents.on('render-process-gone', (_e2, d) => console.log('RENDERER GONE', d));
});
process.on('uncaughtException', (e) => { console.log('MAIN EXCEPTION', e); process.exit(2); });

require(path.join(__dirname, '..', 'main.js'));

const FAKE = `
(() => {
  const rep = (id, n) => ({ reportId: id, items: [{ reportSize: 8, reportCount: n }] });
  class Fake extends EventTarget {
    constructor(p, respond) { super(); Object.assign(this, p); this.opened = false; this.respond = respond; }
    async open() { this.opened = true; } async close() { this.opened = false; }
    async sendReport(id, data) {
      for (const a of this.respond(id, Uint8Array.from(data)) || []) setTimeout(() => {
        const ev = new Event('inputreport'); ev.reportId = a.id; ev.data = new DataView(Uint8Array.from(a.bytes).buffer); this.dispatchEvent(ev);
      }, 2);
    }
  }
  const mouse = new Fake({ vendorId: 0x3554, productId: 0xfb40, productName: 'IO Aurora Pro 8K Receiver', collections: [
    { usagePage: 0xff02, usage: 2, inputReports: [rep(8, 16)], outputReports: [rep(8, 16)], featureReports: [] }] },
    (id, d) => { const r = new Uint8Array(16); r[0] = d[0]; if (d[0] === 3) r[5] = 1; if (d[0] === 4) { r[5] = 45; r[7] = 0x0e; r[8] = 0xa6; } return [{ id: 8, bytes: r }]; });
  const info = new Uint8Array(48); info[17] = 17; info[18] = 0;
  const kbd = new Fake({ vendorId: 0x0c45, productId: 0xfefe, productName: 'IO Type 68 Pro 2.4G', collections: [
    { usagePage: 0xff59, usage: 0x61, inputReports: [rep(0, 64)], outputReports: [rep(0, 64)], featureReports: [] },
    { usagePage: 0xff60, usage: 0x61, inputReports: [rep(0, 32)], outputReports: [rep(0, 32)], featureReports: [] }] },
    (id, d) => { if (d[0] !== 0xaa) return []; const a = d[3] | d[4] << 8, l = d[2], r = new Uint8Array(32);
      r[0] = 0x55; r[1] = 0x10; r[2] = l; r[3] = a; r.set(info.subarray(a, a + l), 8); return [{ id: 0, bytes: r }]; });
  navigator.hid.getDevices = async () => [mouse, kbd];
  return 'stubbed';
})()`;

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const w = BrowserWindow.getAllWindows()[0];
  const wc = w.webContents;
  console.log('hasHID:', await wc.executeJavaScript('typeof navigator.hid'));
  console.log('api:', await wc.executeJavaScript('Object.keys(window.api).join(",")'));
  await new Promise((r) => setTimeout(r, 1500));
  fs.writeFileSync(path.join(out, 'empty.png'), (await wc.capturePage()).toPNG());
  console.log('empty-state text:', await wc.executeJavaScript('document.getElementById("empty").hidden + "|" + document.getElementById("status").textContent'));

  console.log(await wc.executeJavaScript(FAKE));
  wc.send('refresh');
  await new Promise((r) => setTimeout(r, 2500));
  console.log('rows:', await wc.executeJavaScript('Array.from(document.querySelectorAll(".row")).map(r => r.innerText.replace(/\\n+/g," | ")).join(" ## ")'));
  fs.writeFileSync(path.join(out, 'devices.png'), (await wc.capturePage()).toPNG());

  await wc.executeJavaScript('document.getElementById("setDebug").click(); document.getElementById("btnSettings").click();');
  await new Promise((r) => setTimeout(r, 800));
  console.log('log tail:\n' + (await wc.executeJavaScript('document.getElementById("log").textContent')).split('\n').slice(-14).join('\n'));
  fs.writeFileSync(path.join(out, 'settings.png'), (await wc.capturePage()).toPNG());
  app.exit(0);
});
