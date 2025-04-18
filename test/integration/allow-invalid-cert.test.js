/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

const fs = require('fs');
const path = require('path');

var getPort = require('get-port');

const tlsOpts = {
  cert: fs.readFileSync(path.resolve(__dirname, '../fixtures/certs/cert.pem')),
  key: fs.readFileSync(path.resolve(__dirname, '../fixtures/certs/key.pem')),
};

getPort().then(
  function (port) {
    var agent = require('../../').start({
      serviceName: 'test-allow-invalid-cert',
      serverUrl: 'https://localhost:' + port,
      captureExceptions: false,
      metricsInterval: 0,
      centralConfig: false,
      apmServerVersion: '8.0.0',
      disableInstrumentations: ['https'], // avoid the agent instrumenting the mock APM Server
      verifyServerCert: false,
    });

    var https = require('https');
    var test = require('tape');

    test('should allow self signed certificate', function (t) {
      t.plan(3);

      var server = https.createServer(tlsOpts, function (req, res) {
        t.pass('server received client request');
        res.end();
      });

      server.listen(port, function () {
        agent.captureError(new Error('boom!'), function (err) {
          t.error(err, 'no error in captureError');
          t.pass('agent.captureError callback called');
          server.close();
          agent.destroy();
        });
      });
    });
  },
  function (err) {
    throw err;
  },
);
