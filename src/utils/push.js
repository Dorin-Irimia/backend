const https = require('https');

/**
 * Sends Expo push notifications.
 * Silently ignores errors so a push failure never breaks the main request.
 */
async function sendPush(tokens, { title, body, data = {} }) {
  const tokenList = (Array.isArray(tokens) ? tokens : [tokens]).filter(
    t => typeof t === 'string' && t.startsWith('ExponentPushToken['),
  );
  if (!tokenList.length) return;

  const messages = tokenList.map(to => ({ to, title, body, data, sound: 'default' }));
  const payload = JSON.stringify(messages);

  return new Promise(resolve => {
    const req = https.request(
      {
        hostname: 'exp.host',
        path: '/--/api/v2/push/send',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      res => { res.resume(); res.on('end', resolve); },
    );
    req.on('error', resolve);
    req.write(payload);
    req.end();
  });
}

module.exports = { sendPush };
