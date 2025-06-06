/*
 * Copyright Elasticsearch B.V. and other contributors where applicable.
 * Licensed under the BSD 2-Clause License; you may not use this file except in
 * compliance with the BSD 2-Clause License.
 */

'use strict';

// Tests of the instrumentation for `mongodb` module.
//
// They have been split into 3 sections:
// - Test of normal usage of the module with prmises and callback APIs
// - Test of the connection API to ensure the client returnes is properly instrumented
// - Test of cursors working concurrently to check if spans are attached to
//   the right transaction.

if (process.env.GITHUB_ACTIONS === 'true' && process.platform === 'win32') {
  console.log('# SKIP: GH Actions do not support docker services on Windows');
  process.exit(0);
} else if (process.env.TEST_WITHOUT_SERVICES === 'true') {
  console.log('# SKIP: env.TEST_WITHOUT_SERVICES=true');
  process.exit(0);
}

const isMongodbIncompat = require('../../../_is_mongodb_incompat')();
if (isMongodbIncompat) {
  console.log(`# SKIP ${isMongodbIncompat}`);
  process.exit();
}

const test = require('tape');
const semver = require('semver');

const { validateSpan } = require('../../../_validate_schema');
const {
  runTestFixtures,
  safeGetPackageVersion,
  sortApmEvents,
} = require('../../../_utils');

const MONGODB_VERSION = safeGetPackageVersion('mongodb');
// Setting `localhost` will set `span.context.destination.address` to [::1] sometimes
const TEST_HOST = process.env.MONGODB_HOST || '127.0.0.1';
const TEST_PORT = '27017';
const TEST_DB = 'elasticapm';
const TEST_COLLECTION = 'test';
const TEST_USE_CALLBACKS = semver.satisfies(MONGODB_VERSION, '<5');

// From mongodb@3.6.0 and up CommandSuccessEvents may contain errors
const MONGODB_SUCCESS_WITH_ERRORS = semver.satisfies(
  MONGODB_VERSION,
  '>=3.6.0',
);

/** @type {import('../../../_utils').TestFixture[]} */
const testFixtures = [
  {
    name: 'mongodb usage scenario',
    script: 'fixtures/use-mongodb.js',
    cwd: __dirname,
    timeout: 20000, // sanity guard on the test hanging
    maxBuffer: 10 * 1024 * 1024, // This is big, but I don't ever want this to be a failure reason.
    env: {
      TEST_HOST,
      TEST_PORT,
      TEST_DB,
      TEST_COLLECTION,
      TEST_USE_CALLBACKS: String(TEST_USE_CALLBACKS),
    },
    verbose: false,
    checkApmServer: (t, apmServer) => {
      t.ok(apmServer.events[0].metadata, 'metadata');
      const events = sortApmEvents(apmServer.events);

      // First the transaction.
      t.ok(events[0].transaction, 'got the transaction');
      const tx = events.shift().transaction;
      const errors = events.filter((e) => e.error).map((e) => e.error);

      // Compare some common fields across all spans.
      // ignore http/external spans
      const spans = events
        .filter((e) => e.span && e.span.type !== 'external')
        .map((e) => e.span);
      spans.forEach((s) => {
        const errs = validateSpan(s);
        t.equal(errs, null, 'span is valid (per apm-server intake schema)');
      });
      t.equal(
        spans.filter((s) => s.trace_id === tx.trace_id).length,
        spans.length,
        'all spans have the same trace_id',
      );
      t.equal(
        spans.filter((s) => s.transaction_id === tx.id).length,
        spans.length,
        'all spans have the same transaction_id',
      );
      t.equal(
        spans.filter((s) => s.sync === false).length,
        spans.length,
        'all spans have sync=false',
      );
      t.equal(
        spans.filter((s) => s.sample_rate === 1).length,
        spans.length,
        'all spans have sample_rate=1',
      );

      const failingSpanId = spans[TEST_USE_CALLBACKS ? 11 : 8].id; // index of `.deleteOne` with bogus "hint"
      spans.forEach((s) => {
        // Remove variable and common fields to facilitate t.deepEqual below.
        delete s.id;
        delete s.transaction_id;
        delete s.parent_id;
        delete s.trace_id;
        delete s.timestamp;
        delete s.duration;
        delete s.sync;
        delete s.sample_rate;
      });

      // We can't easily assert destination.address because mongodb >3.5.0
      // returns a resolved IP for the given connection hostname. In our CI
      // setup, the host is set to "mongodb" which is a Docker container with
      // some IP. We could `dns.resolve4()` here, but that's overkill I think.
      const RESOLVED_ADDRESS = spans[0].context.destination.address;

      t.ok(RESOLVED_ADDRESS, 'context.destination.address is defined');

      // Work through each of the pipeline functions (insertMany, findOne, ...) in the script:
      const insertManySpan = {
        name: 'elasticapm.test.insert',
        type: 'db',
        subtype: 'mongodb',
        action: 'insert',
        context: {
          service: {
            target: {
              type: 'mongodb',
              name: TEST_DB,
            },
          },
          destination: {
            address: RESOLVED_ADDRESS,
            port: Number(TEST_PORT),
            service: {
              type: '',
              name: '',
              resource: `mongodb/${TEST_DB}`,
            },
          },
          db: {
            type: 'mongodb',
            instance: TEST_DB,
          },
        },
        outcome: 'success',
      };
      t.deepEqual(
        spans.shift(),
        insertManySpan,
        'insertMany produced expected span',
      );

      if (TEST_USE_CALLBACKS) {
        t.deepEqual(
          spans.shift(),
          insertManySpan,
          'insertMany with callback produced expected span',
        );
      }

      const findOneSpan = {
        name: 'elasticapm.test.find',
        type: 'db',
        subtype: 'mongodb',
        action: 'find',
        context: {
          service: {
            target: {
              type: 'mongodb',
              name: TEST_DB,
            },
          },
          destination: {
            address: RESOLVED_ADDRESS,
            port: Number(TEST_PORT),
            service: {
              type: '',
              name: '',
              resource: `mongodb/${TEST_DB}`,
            },
          },
          db: {
            type: 'mongodb',
            instance: TEST_DB,
          },
        },
        outcome: 'success',
      };
      t.deepEqual(spans.shift(), findOneSpan, 'findOne produced expected span');

      t.deepEqual(spans.shift(), findOneSpan, 'findOne 1st concurrent call');
      t.deepEqual(spans.shift(), findOneSpan, 'findOne 2nd concurrent call');
      t.deepEqual(spans.shift(), findOneSpan, 'findOne 3rd concurrent call');

      t.deepEqual(
        spans.shift(),
        { ...findOneSpan, outcome: 'failure' },
        'findOne with bogus "hint" produced expected span',
      );

      if (TEST_USE_CALLBACKS) {
        t.deepEqual(
          spans.shift(),
          findOneSpan,
          'findOne with callback produced expected span',
        );
      }

      const updateOneSpan = {
        name: 'elasticapm.test.update',
        type: 'db',
        subtype: 'mongodb',
        action: 'update',
        context: {
          service: {
            target: {
              type: 'mongodb',
              name: TEST_DB,
            },
          },
          destination: {
            address: RESOLVED_ADDRESS,
            port: Number(TEST_PORT),
            service: {
              type: '',
              name: '',
              resource: `mongodb/${TEST_DB}`,
            },
          },
          db: {
            type: 'mongodb',
            instance: TEST_DB,
          },
        },
        outcome: 'success',
      };
      t.deepEqual(
        spans.shift(),
        updateOneSpan,
        'updateOne produced expected span',
      );

      if (TEST_USE_CALLBACKS) {
        t.deepEqual(
          spans.shift(),
          updateOneSpan,
          'updateOne with callbacks produced expected span',
        );
      }

      const deleteOneSpan = {
        name: 'elasticapm.test.delete',
        type: 'db',
        subtype: 'mongodb',
        action: 'delete',
        context: {
          service: {
            target: {
              type: 'mongodb',
              name: TEST_DB,
            },
          },
          destination: {
            address: RESOLVED_ADDRESS,
            port: Number(TEST_PORT),
            service: {
              type: '',
              name: '',
              resource: `mongodb/${TEST_DB}`,
            },
          },
          db: {
            type: 'mongodb',
            instance: TEST_DB,
          },
        },
        outcome: 'success',
      };
      t.deepEqual(
        spans.shift(),
        deleteOneSpan,
        'deleteOne produced expected span',
      );

      // Delete command errors are not faling
      // - Promise API does not reject
      // - callback API does not return an error param
      // - CommandSucceededvent is fired (althoug it contains error data)
      t.deepEqual(
        spans.shift(),
        deleteOneSpan,
        'deleteOne with bogus "hint" produced expected span',
      );

      if (MONGODB_SUCCESS_WITH_ERRORS) {
        t.equal(errors.length, 1, 'got 1 error');
        t.equal(
          errors[0].parent_id,
          failingSpanId,
          'error is a child of the failing span from deleteOne with bogus "hint"',
        );
      }

      if (TEST_USE_CALLBACKS) {
        t.deepEqual(
          spans.shift(),
          deleteOneSpan,
          'deleteOne with callbacks produced expected span',
        );
      }

      t.deepEqual(
        spans.shift(),
        {
          name: 'elasticapm.test.find',
          type: 'db',
          subtype: 'mongodb',
          action: 'find',
          context: {
            service: {
              target: {
                type: 'mongodb',
                name: TEST_DB,
              },
            },
            destination: {
              address: RESOLVED_ADDRESS,
              port: Number(TEST_PORT),
              service: {
                type: '',
                name: '',
                resource: `mongodb/${TEST_DB}`,
              },
            },
            db: {
              type: 'mongodb',
              instance: TEST_DB,
            },
          },
          outcome: 'success',
        },
        'find produced expected span',
      );

      const deleteManySpan = {
        name: 'elasticapm.test.delete',
        type: 'db',
        subtype: 'mongodb',
        action: 'delete',
        context: {
          service: {
            target: {
              type: 'mongodb',
              name: TEST_DB,
            },
          },
          destination: {
            address: RESOLVED_ADDRESS,
            port: Number(TEST_PORT),
            service: {
              type: '',
              name: '',
              resource: `mongodb/${TEST_DB}`,
            },
          },
          db: {
            type: 'mongodb',
            instance: TEST_DB,
          },
        },
        outcome: 'success',
      };
      t.deepEqual(
        spans.shift(),
        deleteManySpan,
        'deleteMany produced expected span',
      );

      if (TEST_USE_CALLBACKS) {
        t.deepEqual(
          spans.shift(),
          deleteManySpan,
          'deleteMany with callbacks produced expected span',
        );
      }

      t.equal(
        spans.length,
        0,
        `all spans accounted for, remaining spans: ${JSON.stringify(spans)}`,
      );
    },
  },
  {
    name: 'mongodb variations of connection',
    script: 'fixtures/use-mongodb-connect.js',
    cwd: __dirname,
    timeout: 20000, // sanity guard on the test hanging
    maxBuffer: 10 * 1024 * 1024, // This is big, but I don't ever want this to be a failure reason.
    env: {
      TEST_HOST,
      TEST_PORT,
      TEST_DB,
      TEST_COLLECTION,
      TEST_USE_CALLBACKS: String(TEST_USE_CALLBACKS),
    },
    verbose: false,
    checkApmServer: (t, apmServer) => {
      t.ok(apmServer.events[0].metadata, 'metadata');
      const events = sortApmEvents(apmServer.events);

      const tx = events.shift().transaction;
      t.ok(tx, 'got the transaction');

      const spans = events
        .filter(
          (e) =>
            e.span && e.span.type !== 'external' && e.span.action === 'find',
        )
        .map((e) => e.span);

      spans.forEach((s) => {
        // Remove variable and common fields to facilitate t.deepEqual below.
        delete s.id;
        delete s.transaction_id;
        delete s.parent_id;
        delete s.trace_id;
        delete s.timestamp;
        delete s.duration;
        delete s.sync;
        delete s.sample_rate;
      });

      const connectionsMade = TEST_USE_CALLBACKS ? 4 : 1;

      for (let i = 0; i < connectionsMade; i++) {
        let span = spans.shift();
        // We can't easily assert destination.address because mongodb >3.5.0
        // returns a resolved IP for the given connection hostname. In our CI
        // setup, the host is set to "mongodb" which is a Docker container with
        // some IP. We could `dns.resolve4()` here, but that's overkill I think.
        let addr = span.context.destination.address;

        t.ok(addr, 'context.destination.address is defined');
        t.deepEqual(
          span,
          {
            name: 'elasticapm.test.find',
            type: 'db',
            subtype: 'mongodb',
            action: 'find',
            context: {
              service: {
                target: {
                  type: 'mongodb',
                  name: TEST_DB,
                },
              },
              destination: {
                address: addr,
                port: Number(TEST_PORT),
                service: {
                  type: '',
                  name: '',
                  resource: `mongodb/${TEST_DB}`,
                },
              },
              db: {
                type: 'mongodb',
                instance: TEST_DB,
              },
            },
            outcome: 'success',
          },
          'findOne produced expected span',
        );
      }

      t.equal(spans.length, 0, 'all spans accounted for');
    },
  },
  {
    name: 'mongodb concurrency and async context',
    script: 'fixtures/use-mongodb-async-context.js',
    cwd: __dirname,
    timeout: 20000, // sanity guard on the test hanging
    maxBuffer: 10 * 1024 * 1024, // This is big, but I don't ever want this to be a failure reason.
    env: {
      TEST_HOST,
      TEST_PORT,
      TEST_DB,
      TEST_COLLECTION,
    },
    // The `getMore` command seems to be queued outside the connection pool
    // for versions <4.11.0 and as a result the `find` command is properly
    // linked to the parent transaction but not the `getMore` commands from
    // the cursor. Since v4.11.0 was published in 2022-09-19 there was a decision
    // to skip this test for earlier version
    // Ref: https://github.com/elastic/apm-agent-nodejs/pull/3919#issuecomment-2005283132
    versionRanges: {
      mongodb: '>=4.11.0',
    },
    verbose: false,
    checkApmServer: (t, apmServer) => {
      t.ok(apmServer.events[0].metadata, 'metadata');
      const events = sortApmEvents(apmServer.events);

      const transactions = events
        .filter((e) => e.transaction)
        .map((e) => e.transaction);

      const spans = events
        .filter((e) => e.span && e.span.type !== 'external')
        .map((e) => e.span);

      const extractSpans = (tx) => {
        const result = [];
        let i = 0;

        while (i < spans.length) {
          if (spans[i].parent_id === tx.id) {
            result.push(...spans.splice(i, 1));
          } else {
            i++;
          }
        }

        return result;
      };

      let tx = transactions.shift();
      let txSpans = extractSpans(tx);

      // Assertions for insert transaction
      t.ok(tx, 'insert transaction');
      t.ok(txSpans.length === 1, 'insert spans length');
      t.equal(txSpans[0].name, 'elasticapm.test.insert', 'span.name');

      // Assertions for all find transactions
      while (transactions.length - 1) {
        tx = transactions.shift();
        txSpans = extractSpans(tx);

        t.ok(txSpans.length > 0, 'transaction has child spans');

        txSpans.forEach((s, idx) => {
          if (idx === 0) {
            t.equal(s.name, 'elasticapm.test.find', 'span.name');
          } else {
            t.equal(s.name, 'elasticapm.test.getMore', 'span.name');
          }
        });
      }

      // Assertions for delete transaction
      tx = transactions.shift();
      txSpans = extractSpans(tx);

      t.ok(txSpans.length === 1, 'delete spans length');
      t.equal(txSpans[0].name, 'elasticapm.test.delete', 'span.name');

      t.equal(spans.length, 0, 'all spans accounted for');
    },
  },
];

test('mongodb fixtures', (suite) => {
  runTestFixtures(suite, testFixtures);
  suite.end();
});
