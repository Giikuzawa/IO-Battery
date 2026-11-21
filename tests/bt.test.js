'use strict';
// Проверка PowerShell-скриптов Bluetooth на подставных командлетах. Нужен pwsh (PWSH=/путь/к/pwsh).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { FULL, QUICK } = require('../bt-scripts.js');

const pwsh = process.env.PWSH;
if (!pwsh || !fs.existsSync(pwsh)) { console.log('  skip  bt.test.js (нет pwsh, задайте PWSH=…)'); process.exit(0); }

const mock = fs.readFileSync(path.join(__dirname, 'bt-mock.ps1'), 'utf8');
function run(script, extra = '') {
  const f = path.join(os.tmpdir(), `bt-${process.pid}-${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(f, mock + '\n' + extra + '\n' + script, 'utf8');
  const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', f], { encoding: 'utf8', env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' } });
  fs.unlinkSync(f);
  assert.equal(r.status, 0, `pwsh завершился с кодом ${r.status}: ${r.stderr}`);
  const text = r.stdout.trim();
  return JSON.parse(text.slice(text.indexOf('[')));
}

let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n      ', e.message); process.exitCode = 1; } };

const full = run(FULL);
const by = (name) => full.filter((x) => x.name === name);

t('FULL: клавиатура BLE найдена под корневым именем, оба узла сгруппированы', () => {
  const kb = by('IO Type68 Pro BT2');
  assert.ok(kb.length >= 1);
  assert.ok(kb.every((x) => x.pct === 61 && x.connected === false));
  assert.ok(kb[0].ids.length === 2, 'в контейнере два узла: BTHLE и HID');
});
t('FULL: у наушников имя берётся у корневого узла, а не «… Hands-Free AG»', () => {
  const hp = by('MONITOR III A.N.C.');
  assert.equal(hp.length, 1);
  assert.equal(hp[0].pct, 98); assert.equal(hp[0].connected, true);
});
t('FULL: устройство без корневого узла берёт собственное имя; связь неизвестна → null', () => {
  const pad = by('Wireless Controller');
  assert.equal(pad.length, 1); assert.equal(pad[0].pct, 77); assert.equal(pad[0].connected, null);
});
t('FULL: устройства без заряда (USB-приёмник, системные) не попадают в список', () => {
  assert.ok(!full.some((x) => /receiver|interrupt/i.test(x.name)));
});

const entries = full.map(({ id, ids }) => ({ id, ids }));
const toText = (list) => list.map((k) => [k.id, ...k.ids].join('\t')).join('\n');
const b64 = Buffer.from(toText(entries), 'utf8').toString('base64');
const quick = run(QUICK.replace('__ENTRIES_B64__', b64), '$global:MockBat[$kbRoot]=55; $global:MockBat[$hpHfp]=97; $global:MockConn[$hpRoot]=$false');

t('QUICK: свежие значения и состояние связи читаются только по известным узлам', () => {
  const kb = quick.find((x) => x.id.startsWith('BTHLE\\'));
  const hp = quick.find((x) => x.id.startsWith('BTHENUM\\{'));
  assert.equal(kb.pct, 55);
  assert.equal(hp.pct, 97); assert.equal(hp.connected, false);
});
t('QUICK: одна строка и CRLF-переводы строк разбираются', () => {
  const one = Buffer.from(toText([entries[0]]), 'utf8').toString('base64');
  const r = run(QUICK.replace('__ENTRIES_B64__', one));
  assert.equal(r.length, 1);
  const crlf = Buffer.from(toText(entries).replace(/\n/g, '\r\n'), 'utf8').toString('base64');
  assert.equal(run(QUICK.replace('__ENTRIES_B64__', crlf)).length, entries.length);
});

console.log(`  bt: пройдено ${n}`);

t('QUICK: скрипт не использует ConvertFrom-Json (в PowerShell 5.1 он разворачивает массивы иначе, чем в 7)', () => {
  assert.ok(!/ConvertFrom-Json/.test(QUICK));
});
