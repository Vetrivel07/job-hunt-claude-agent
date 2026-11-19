// WhatsApp sender. Providers:
//   callmebot — free, for messages to your own number (https://www.callmebot.com/blog/free-api-whatsapp-messages/)
//   twilio    — paid/sandbox, Twilio WhatsApp API
//   none      — print only (useful while testing)

const MAX_LEN = 1500; // Twilio's WhatsApp limit is 1600; stay under it for both

export function truncate(text, max = MAX_LEN) {
  if (text.length <= max) return text;
  return text.slice(0, max - 40).replace(/\n[^\n]*$/, '') + '\n… (truncated, see job-log.xlsx)';
}

async function sendCallMeBot(text, env) {
  const phone = (env.CALLMEBOT_PHONE || '').replace(/[^\d+]/g, '');
  const apikey = env.CALLMEBOT_APIKEY || '';
  if (!phone || !apikey) throw new Error('CALLMEBOT_PHONE and CALLMEBOT_APIKEY must be set in automation/.env');
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apikey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const body = await res.text();
  // CallMeBot returns 200 with an HTML page; errors contain "APIKey is invalid" etc.
  if (!res.ok || /invalid|error|not allowed/i.test(body.replace(/<[^>]+>/g, ' ').slice(0, 2000)) && !/Message queued|Message Sent/i.test(body)) {
    throw new Error(`CallMeBot HTTP ${res.status}: ${body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }
  return { ok: true, provider: 'callmebot' };
}

async function sendTwilio(text, env) {
  const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM, to = env.TWILIO_TO;
  if (!sid || !token || !from || !to) throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM and TWILIO_TO must be set in automation/.env');
  const norm = (n) => (n.startsWith('whatsapp:') ? n : `whatsapp:${n}`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: norm(from), To: norm(to), Body: text }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Twilio HTTP ${res.status}: ${body.slice(0, 300)}`);
  return { ok: true, provider: 'twilio' };
}

/** Send one message. Never throws: returns {ok, error?}. */
export async function sendWhatsApp(text, env = process.env) {
  const provider = (env.WHATSAPP_PROVIDER || 'none').toLowerCase();
  const msg = truncate(text);
  try {
    if (provider === 'callmebot') return await sendCallMeBot(msg, env);
    if (provider === 'twilio') return await sendTwilio(msg, env);
    console.log('\n--- WhatsApp (provider=none, not sent) ---\n' + msg + '\n---');
    return { ok: true, provider: 'none' };
  } catch (err) {
    return { ok: false, provider, error: err.message };
  }
}
