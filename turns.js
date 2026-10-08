// Running replies: one at a time per chat, either streamed back to the HTTP
// request that asked for it, or started in the background (reminders,
// contacts texting first) and pushed to every open window over SSE.

const E = require('./engine');

const active = new Map(); // chat id -> AbortController
const listeners = new Set(); // open /api/events responses

const isBusy = (chatId) => active.has(chatId);
const stop = (chatId) => active.get(chatId)?.abort();

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of listeners) {
    if (!res.writableEnded) res.write(line);
  }
}

function subscribe(req, res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  listeners.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(keepAlive);
    listeners.delete(res);
  });
}

// prepare(emit) -> { responders, directive?, kind? }; may be async (web search etc.)
function streamTurn(req, res, chat, prepare) {
  if (active.has(chat.id)) return res.status(409).json({ error: 'Still replying, hang on a sec' });

  const controller = new AbortController();
  active.set(chat.id, controller);

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // A closed tab or reload does NOT cancel the reply (like a real messenger);
  // only an explicit POST /stop does. Other windows learn about it via SSE.

  const emit = (event) => {
    if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(event) + '\n');
  };

  (async () => {
    try {
      const { responders, directive = '', kind = '' } = await prepare(emit);
      await E.runTurn({ chat, responders, emit, signal: controller.signal, directive, kind });
    } catch (err) {
      console.error('turn failed', err);
      emit({ type: 'error', chat_id: chat.id, error: err.message });
    } finally {
      active.delete(chat.id);
      emit({ type: 'done', chat_id: chat.id });
      res.end();
      broadcast({ type: 'chats_changed' });
    }
  })();
}

// Returns false if the chat is already busy (caller retries later).
async function runBackground(chat, responders, { directive = '', kind = '' } = {}) {
  if (active.has(chat.id) || !responders.length) return false;
  const controller = new AbortController();
  active.set(chat.id, controller);
  broadcast({ type: 'turn_start', chat_id: chat.id, kind });
  try {
    await E.runTurn({ chat, responders, emit: broadcast, signal: controller.signal, directive, kind });
  } catch (err) {
    console.error('background turn failed', err);
    broadcast({ type: 'error', chat_id: chat.id, error: err.message });
  } finally {
    active.delete(chat.id);
    broadcast({ type: 'turn_end', chat_id: chat.id });
  }
  return true;
}

module.exports = { isBusy, stop, broadcast, subscribe, streamTurn, runBackground };
