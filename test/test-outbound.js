#!/usr/bin/env node
//
// End-to-end test for ttyd outbound websocket (--connect) mode.
//
// Starts a WebSocket server, launches ttyd in client mode against it,
// verifies bidirectional communication, then exits with 0 on success.
//
// Usage:
//   npm install ws   # one-time
//   node test/test-outbound.js [path-to-ttyd-binary]
//

const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');
const path = require('path');

const TTYD = process.argv[2] || path.join(__dirname, '..', 'build', 'ttyd');
const PORT = 0; // let the OS pick a free port
const SHARED_KEY = randomBytes(32);
const SHARED_KEY_ARG = SHARED_KEY.toString('base64url');

function encryptPayload(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', SHARED_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]);
}

function decryptPayload(payload) {
  if (payload.length < 28) throw new Error('encrypted payload too short');
  const iv = payload.subarray(0, 12);
  const ciphertext = payload.subarray(12, payload.length - 16);
  const tag = payload.subarray(payload.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', SHARED_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function startServer() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({
      port: PORT,
      handleProtocols: (protocols) => (protocols.has('tty') ? 'tty' : false),
    });

    wss.on('listening', () => {
      const port = wss.address().port;
      resolve({ wss, port });
    });
  });
}

function runTest(wss, port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('test timed out after 10s'));
    }, 10000);

    const results = {
      connected: false,
      gotTitle: false,
      gotPrefs: false,
      gotOutput: false,
      inputEchoed: false,
      payloadsEncrypted: true,
      cleanClose: false,
    };

    wss.on('connection', (ws) => {
      results.connected = true;
      let sentInput = false;

      ws.on('message', (data) => {
        const buf = Buffer.from(data);
        const cmd = String.fromCharCode(buf[0]);
        const rawPayload = buf.slice(1);
        let payload;
        try {
          payload = decryptPayload(rawPayload).toString();
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
          return;
        }

        switch (cmd) {
          case '1': // SET_WINDOW_TITLE
            results.gotTitle = true;
            break;
          case '2': // SET_PREFERENCES
            results.gotPrefs = true;
            break;
          case '0': // OUTPUT
            results.gotOutput = true;
            if (rawPayload.includes(Buffer.from('OUTBOUND_TEST_OK'))) {
              results.payloadsEncrypted = false;
            }
            if (payload.includes('OUTBOUND_TEST_OK')) {
              results.inputEchoed = true;
            }

            // Once we get some output, send a command and then exit
            if (!sentInput) {
              sentInput = true;
              const input = 'echo OUTBOUND_TEST_OK\n';
              const encrypted = encryptPayload(Buffer.from(input));
              const msg = Buffer.alloc(1 + encrypted.length);
              msg[0] = '0'.charCodeAt(0); // INPUT
              encrypted.copy(msg, 1);
              ws.send(msg);

              setTimeout(() => {
                const exitPayload = encryptPayload(Buffer.from('exit\n'));
                const exitMsg = Buffer.alloc(1 + exitPayload.length);
                exitMsg[0] = '0'.charCodeAt(0);
                exitPayload.copy(exitMsg, 1);
                ws.send(exitMsg);
              }, 500);
            }
            break;
        }
      });

      ws.on('close', (code) => {
        results.cleanClose = code === 1000;
        clearTimeout(timeout);
        resolve(results);
      });
    });

    // Launch ttyd in client mode
    const ttyd = spawn(TTYD, ['--connect-shared-key', SHARED_KEY_ARG, '--connect', `ws://localhost:${port}`, '-W', 'bash'], {
      stdio: 'ignore',
    });

    ttyd.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`failed to spawn ttyd: ${err.message}`));
    });
  });
}

async function main() {
  const { wss, port } = await startServer();
  console.log(`test server listening on port ${port}`);

  try {
    const results = await runTest(wss, port);

    console.log('');
    const checks = [
      ['Client connected', results.connected],
      ['SET_WINDOW_TITLE received', results.gotTitle],
      ['SET_PREFERENCES received', results.gotPrefs],
      ['OUTPUT received', results.gotOutput],
      ['Remote input echoed back', results.inputEchoed],
      ['Wire payloads encrypted', results.payloadsEncrypted],
      ['Clean disconnect (code 1000)', results.cleanClose],
    ];

    let allPass = true;
    for (const [name, pass] of checks) {
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
      if (!pass) allPass = false;
    }

    console.log(`\n${allPass ? 'ALL PASS' : 'SOME FAILED'}`);
    process.exit(allPass ? 0 : 1);
  } finally {
    wss.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
