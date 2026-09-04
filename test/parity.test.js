'use strict';

// Verifies the 2.0 moment-timezone output is byte-identical to what the old
// native `time` module produced.
//
// The old module read its zone data straight from the C library, so glibc via
// `date(1)` is used here as the reference oracle. The expected strings are
// rebuilt from the pre-2.0 source:
//
//   /getTime        getFullYear(),getMonth()+1,getDate(),getHours(),
//                   getMinutes(),getSeconds()          -> %Y,%-m,%-d,%-H,%-M,%-S
//   /getTimeZone    toString().split(' ')[6], parens stripped
//                   = tzname[isDaylightSavings ? 1 : 0] -> %Z
//   /getTimeOffset  toString().split(' ')[5]
//                   = 'GMT' + sign + pad(hh,2) + pad(mm,2) -> GMT%z
//   /getTimeRaw     toDateString() + ' ' + toTimeString()  -> %a %b %d %Y %H:%M:%S GMT%z (%Z)

const http = require('http');
const { execFileSync } = require('child_process');
const moment = require('moment-timezone');

const TZ_AT_START = process.env.TZ;

const { app, formatters, resolveZone, serverOffsetMs } = require('../time-zone-service.js');

const ZONES = [
  'Europe/Berlin', 'Europe/Zurich', 'Europe/London', 'Europe/Dublin',
  'Europe/Moscow', 'Europe/Lisbon', 'America/New_York', 'America/Chicago',
  'America/Denver', 'America/Los_Angeles', 'America/St_Johns',
  'America/Sao_Paulo', 'America/Argentina/Buenos_Aires',
  'America/Indiana/Indianapolis', 'Asia/Tokyo', 'Asia/Shanghai',
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Kathmandu', 'Asia/Tehran',
  'Australia/Sydney', 'Australia/Adelaide', 'Australia/Perth',
  'Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Kiritimati',
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'UTC',
];

// Winter, summer, and instants either side of the EU/US DST switchovers.
const INSTANTS = [
  Date.UTC(2026, 0, 15, 12, 0, 0),
  Date.UTC(2026, 6, 15, 12, 0, 0),
  Date.UTC(2026, 2, 8, 6, 59, 0),   // US spring forward
  Date.UTC(2026, 2, 8, 7, 1, 0),
  Date.UTC(2026, 2, 29, 0, 59, 0),  // EU spring forward
  Date.UTC(2026, 2, 29, 1, 1, 0),
  Date.UTC(2026, 9, 25, 0, 59, 0),  // EU fall back
  Date.UTC(2026, 9, 25, 1, 1, 0),
  Date.UTC(2026, 10, 1, 5, 59, 0),  // US fall back
  Date.UTC(2026, 8, 4, 23, 30, 45), // date rolls over in many zones
  Date.UTC(2027, 1, 28, 23, 59, 59),
];

function glibc(zone, epochMs, fmt) {
  return execFileSync('date', ['-d', '@' + Math.floor(epochMs / 1000), '+' + fmt], {
    env: { ...process.env, TZ: zone, LC_ALL: 'C' },
    encoding: 'utf8',
  }).trim();
}

const REFERENCE = {
  '/getTime': (z, t) => glibc(z, t, '%Y,%-m,%-d,%-H,%-M,%-S'),
  '/getTimeZone': (z, t) => glibc(z, t, '%Z'),
  '/getTimeOffset': (z, t) => glibc(z, t, 'GMT%z'),
  '/getTimeRaw': (z, t) => glibc(z, t, '%a %b %d %Y %H:%M:%S GMT%z (%Z)'),
};

let checks = 0;
let failures = 0;

function check(label, actual, expected) {
  checks++;
  if (actual !== expected) {
    failures++;
    console.error(`  FAIL ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------- format parity
console.log(`Format parity vs glibc: ${ZONES.length} zones x ${INSTANTS.length} instants`);
for (const zone of ZONES) {
  for (const t of INSTANTS) {
    const now = moment(t).tz(zone).locale('en');
    for (const path of Object.keys(formatters)) {
      check(`${path} ${zone} @${new Date(t).toISOString()}`, formatters[path](now), REFERENCE[path](zone, t));
    }
  }
}

// ------------------------------------------------------------ zone validation
console.log('Zone validation');
check('2-part valid', resolveZone(['Europe', 'Berlin', undefined]), 'Europe/Berlin');
check('3-part valid', resolveZone(['America', 'Argentina', 'Buenos_Aires']), 'America/Argentina/Buenos_Aires');
for (const bad of [
  ['Foo', 'Bar', undefined],
  ['..', '..', 'etc'],
  ['../../..', 'etc/passwd', undefined],
  ['A'.repeat(200), 'B', undefined],
  [':/etc/passwd', 'x', undefined],
]) {
  check(`reject ${JSON.stringify(bad)}`, resolveZone(bad), null);
}

// ------------------------------------------------------------------ HTTP tests
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = (p) => new Promise((resolve, reject) => {
    http.get(base + p, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });

  console.log('HTTP behaviour');

  // A live response must match glibc for the same instant. The server adds
  // serverOffsetMs, so allow for the request straddling a second boundary.
  for (const path of Object.keys(formatters)) {
    const before = Date.now();
    const res = await get(`${path}/Europe/Berlin`);
    const after = Date.now();
    const allowed = new Set();
    for (let t = before; t <= after + 1; t++) allowed.add(REFERENCE[path]('Europe/Berlin', t + serverOffsetMs));
    checks++;
    if (res.status !== 200 || !allowed.has(res.body)) {
      failures++;
      console.error(`  FAIL live ${path} -> ${res.status} ${JSON.stringify(res.body)}; allowed ${[...allowed].map((x) => JSON.stringify(x)).join(' | ')}`);
    }
  }

  // Regression test for the pre-2.0 bug: one bad request left process.env.TZ
  // poisoned, so every later request served a silently wrong time.
  const clean = await get('/getTime/Europe/Berlin');
  const bad = await get('/getTime/Foo/Bar');
  const afterAttack = await get('/getTime/Europe/Berlin');

  check('bad zone -> 400', bad.status, 400);
  check('bad zone leaks no stack trace', /at |\.js:\d+|node_modules/.test(bad.body), false);
  check('process.env.TZ untouched', process.env.TZ, TZ_AT_START);
  check(
    'good request still correct after attack',
    afterAttack.body.split(',').slice(0, 4).join(','),
    clean.body.split(',').slice(0, 4).join(','),
  );

  const traversal = await get('/getTime/..%2f..%2f..%2fetc/passwd');
  check('path traversal -> 400', traversal.status, 400);

  server.close();
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.error(`${failures} FAILED`);
    process.exit(1);
  }
  console.log('All parity checks passed.');
});
