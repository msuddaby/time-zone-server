'use strict';

const express = require('express');
const moment = require('moment-timezone');

const app = express();
const port = process.env.PORT || 3000;

// Nudge the reported time forward to compensate for network latency and client
// processing, so the clock receiving this response lands on the right second.
const serverOffsetMs = 1100;

// Longest real IANA name is 32 chars ("America/Argentina/ComodRivadavia").
const MAX_ZONE_LENGTH = 64;

// Resolves the URL segments to an IANA zone name, or null if it isn't a zone we
// know. moment.tz.zone() is a plain dictionary lookup: unlike the old `time`
// module it never assigns to process.env.TZ, so an unknown zone cannot leave
// global state behind to corrupt subsequent requests.
function resolveZone(segments) {
  const name = segments.filter(Boolean).join('/');
  if (name.length > MAX_ZONE_LENGTH) {
    return null;
  }
  return moment.tz.zone(name) ? name : null;
}

function nowIn(zone) {
  // locale('en') is pinned so ddd/MMM stay English regardless of ambient config.
  return moment(Date.now() + serverOffsetMs).tz(zone).locale('en');
}

// Registers the 2-part (area/location) and 3-part (area/location/city) forms of
// an endpoint, which differ only in how the result is rendered.
function register(path, render) {
  function handler(req, res) {
    logClientID(req);
    const zone = resolveZone([req.params.area, req.params.location, req.params.city]);
    if (zone === null) {
      // Deliberately does not echo the requested zone back to the caller.
      res.status(400).send('Unknown timezone');
      return;
    }
    res.send(render(nowIn(zone)));
  }

  app.get(path + '/:area/:location', handler);
  app.get(path + '/:area/:location/:city', handler);
}

// Response formats, kept byte-identical to the pre-2.0 `time` module output.
const formatters = {
  // "2016,4,18,15,56,8" - unpadded, month is 1-based
  '/getTime': (now) => now.format('YYYY,M,D,H,m,s'),
  // "CEST"
  '/getTimeZone': (now) => now.format('z'),
  // "GMT+0200"
  '/getTimeOffset': (now) => now.format('[GMT]ZZ'),
  // "Tue Apr 19 2016 09:47:30 GMT+0200 (CEST)"
  '/getTimeRaw': (now) => now.format('ddd MMM DD YYYY HH:mm:ss [GMT]ZZ (z)'),
};

Object.keys(formatters).forEach((path) => register(path, formatters[path]));

function logClientID(request) {
  if ((request.headers.clientid !== undefined) && (request.headers.esp !== undefined)) {
    // Strip control characters so a malicious header cannot forge log lines.
    const clean = (v) => String(v).replace(/[\u0000-\u001f\u007f]/g, '');
    console.log('Client: ' + clean(request.headers.clientid) + ' --> ' + clean(request.headers.esp));
  }
}

// Backstop: keep stack traces in the log and out of the response, whatever
// NODE_ENV happens to be.
app.use((err, req, res, next) => {
  console.error(err && err.stack ? err.stack : err);
  res.status(500).send('Internal error');
});

if (require.main === module) {
  app.listen(port);
  console.log('Listening on port ' + port + '...');
}

module.exports = { app, formatters, resolveZone, nowIn, serverOffsetMs };
