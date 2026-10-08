// Chat engine: builds model context, streams replies (split into short
// "bursts" of separate texts), decides who answers in a group, and maintains
// rolling memory.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { streamChat, chatOnce, unloadOthers, modelCapabilities, canSee, ThinkFilter } = require('./ollama');
const P = require('./prompts');
const Memory = require('./memory');

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const MAX_BURST = 3; // max separate texts per reply
const IMAGE_LOOKBACK = 4; // only the most recent photos are sent to the model
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

// ---------- Lookups ----------

function getSettings() {
  const settings = {};
  for (const row of db.prepare('SELECT key, value FROM app_settings').all()) settings[row.key] = row.value;
  return settings;
}

function ollamaUrl(settings = getSettings()) {
  const url = (settings.ollama_url || '').trim().replace(/\/+$/, '');
  return url || DEFAULT_OLLAMA_URL;
}

const userLabel = (settings) => (settings.user_name || '').trim() || 'Friend';
const getChat = (id) => db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
const getContact = (id) => db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);

function chatMembers(chat) {
  if (chat.kind === 'dm') {
    const c = getContact(chat.contact_id);
    return c ? [c] : [];
  }
  return db
    .prepare(
      `SELECT c.* FROM chat_members cm JOIN contacts c ON c.id = cm.contact_id
       WHERE cm.chat_id = ? ORDER BY c.name COLLATE NOCASE`
    )
    .all(chat.id);
}

const MESSAGE_SELECT = `
  SELECT m.*, r.content AS reply_content, r.role AS reply_role, r.sender_name AS reply_sender,
         r.attachments AS reply_attachments
  FROM messages m LEFT JOIN messages r ON r.id = m.reply_to`;

const parseJSON = (s, fallback) => {
  try {
    return JSON.parse(s) ?? fallback;
  } catch {
    return fallback;
  }
};

const fileStmt = db.prepare('SELECT * FROM files WHERE id = ?');

// Full file rows (including extracted text) for a message row.
function filesOf(row) {
  return parseJSON(row.attachments || '[]', [])
    .map((id) => fileStmt.get(id))
    .filter(Boolean);
}

const publicFile = (f) => ({
  id: f.id,
  url: f.url,
  name: f.name,
  kind: f.kind,
  mime: f.mime || '',
  size: f.size || 0,
  pages: f.pages || 0,
  text_chars: (f.text || '').length,
});

function attachmentSummary(row) {
  const files = filesOf(row);
  if (!files.length) return '';
  if (files.every((f) => f.kind === 'image')) return files.length > 1 ? `📷 ${files.length} photos` : '📷 Photo';
  const doc = files.find((f) => f.kind !== 'image');
  return `📄 ${doc.name}${files.length > 1 ? ` +${files.length - 1}` : ''}`;
}

function serializeMessage(r) {
  if (!r) return null;
  const reactions = parseJSON(r.reactions || '[]', []);
  const replyAttach = r.reply_role ? attachmentSummary({ attachments: r.reply_attachments }) : '';
  return {
    id: r.id,
    chat_id: r.chat_id,
    role: r.role,
    sender_id: r.contact_id,
    sender_name: r.sender_name,
    content: r.content,
    attachments: filesOf(r).map(publicFile),
    reply_to: r.reply_to,
    reply: r.reply_to
      ? r.reply_role
        ? { role: r.reply_role, sender_name: r.reply_sender, content: r.reply_content, attachment: replyAttach }
        : { deleted: true }
      : null,
    reactions,
    kind: r.kind || '',
    meta: parseJSON(r.meta || '{}', {}),
    edited: !!r.edited,
    created_at: r.created_at,
  };
}

const getMessage = (id) => serializeMessage(db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id));

function insertMessage({ chatId, contact, role, content, attachments = [], replyTo = null, kind = '', meta = {} }) {
  const info = db
    .prepare(
      `INSERT INTO messages (chat_id, contact_id, sender_name, role, content, attachments, reply_to, kind, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(chatId, contact ? contact.id : null, contact ? contact.name : '', role, content, JSON.stringify(attachments), replyTo, kind, JSON.stringify(meta));
  return getMessage(Number(info.lastInsertRowid));
}

// ---------- Context ----------

function readImageBase64(url) {
  if (!url || !url.startsWith('/uploads/')) return null;
  const file = path.join(UPLOADS_DIR, path.basename(url));
  try {
    if (fs.statSync(file).size > 8 * 1024 * 1024) return null;
    return fs.readFileSync(file).toString('base64');
  } catch {
    return null;
  }
}

const snippet = (s, n) => {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// Document text gets at most this share of the history budget, newest files first.
const FILE_SHARE = 0.6;
const MAX_IMAGES_PER_MESSAGE = 4;

function describeFiles(files, fileBudget, vision) {
  const notes = [];
  const blocks = [];
  for (const f of files) {
    if (f.kind === 'image') {
      notes.push(vision ? '[sent a photo]' : "[sent a photo, but you can't see images so you don't know what's in it]");
      continue;
    }
    const label = `${f.name}${f.pages ? `, ${f.pages} page${f.pages === 1 ? '' : 's'}` : ''}`;
    const text = (f.text || '').trim();
    if (!text) {
      notes.push(`[sent a file: ${label}. No readable text in it${f.kind === 'pdf' ? ' (probably a scanned PDF)' : ''}]`);
    } else if (fileBudget.left < 400) {
      notes.push(`[sent a file earlier: ${label}]`);
    } else {
      const shown = text.slice(0, fileBudget.left);
      fileBudget.left -= shown.length;
      const cut = shown.length < text.length ? '\n[...the rest of the file was too long to include]' : '';
      blocks.push(`[sent a file: ${label}]\n<<<\n${shown}${cut}\n>>>`);
    }
  }
  return { notes, blocks };
}

function buildHistory(chat, contact, userName, budgetChars, vision) {
  const rows = db.prepare(`${MESSAGE_SELECT} WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT 120`).all(chat.id);
  const out = [];
  const fileBudget = { left: Math.floor(budgetChars * FILE_SHARE) };
  let used = 0;
  rows.forEach((r, i) => {
    if (used > budgetChars) return;
    const files = filesOf(r);
    const { notes, blocks } = describeFiles(files, fileBudget, vision);
    let text = [...notes, r.content || ''].filter(Boolean).join(' ');
    if (blocks.length) text = `${blocks.join('\n\n')}\n\n${text}`.trim();
    if (r.reply_to && r.reply_content) text = `(replying to "${snippet(r.reply_content, 80)}") ${text}`;

    const mine = r.role === 'assistant' && r.contact_id === contact.id;
    let msg;
    if (chat.kind === 'group') {
      const who = r.role === 'user' ? userName : r.sender_name || 'Someone';
      msg = mine ? { role: 'assistant', content: text } : { role: 'user', content: `${who}: ${text}` };
    } else {
      msg = { role: r.role === 'user' ? 'user' : 'assistant', content: text };
    }
    used += msg.content.length;
    if (used > budgetChars && out.length) return;
    if (vision && r.role === 'user' && i < IMAGE_LOOKBACK) {
      const images = files
        .filter((f) => f.kind === 'image')
        .slice(0, MAX_IMAGES_PER_MESSAGE)
        .map((f) => readImageBase64(f.url))
        .filter(Boolean);
      if (images.length) msg.images = images;
    }
    out.push(msg);
  });
  out.reverse();

  // merge consecutive turns from the same side; assistant bursts keep their blank-line format
  const merged = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      prev.content += (m.role === 'assistant' ? '\n\n' : '\n') + m.content;
      if (m.images) prev.images = [...(prev.images || []), ...m.images];
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}

function friendlyError(err, model, baseUrl) {
  const msg = err?.message || String(err);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(msg) || err?.cause?.code === 'ECONNREFUSED') {
    return `Can't reach Ollama at ${baseUrl}. Is it running?`;
  }
  if (err?.status === 404 || /not found/i.test(msg)) return `Model "${model}" isn't installed (try: ollama pull ${model})`;
  return msg;
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

// ---------- Generation ----------

function humanGap(ms) {
  const h = ms / 36e5;
  if (h < 2) return null;
  if (h < 36) return `about ${Math.round(h)} hours`;
  return `${Math.round(h / 24)} days`;
}

// How long it had been quiet before the latest exchange, e.g. "about 9 hours".
function quietGap(chat) {
  const recent = db.prepare('SELECT role, created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 2').all(chat.id);
  if (!recent.length) return null;
  const now = Date.now();
  if (recent[0].role === 'user' && recent[1]) return humanGap(new Date(recent[0].created_at) - new Date(recent[1].created_at));
  return humanGap(now - new Date(recent[0].created_at));
}

function recallQueries(chat) {
  const recent = db.prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 3').all(chat.id);
  const lastUser = recent.find((r) => r.role === 'user')?.content || '';
  const window = recent.map((r) => r.content).reverse().join('\n').slice(-600);
  return [lastUser.slice(-400), window];
}

// directive: a one-off instruction for this reply (send a reminder, text first,
// use these search results, ...). kind/meta are stored on the saved messages.
async function replyAs({ chat, contact, group, settings, emit, signal, directive = '', kind = '' }) {
  const baseUrl = ollamaUrl(settings);
  const style = contact.style || 'texting';
  const userName = userLabel(settings);
  const user = { name: (settings.user_name || '').trim(), about: settings.user_about };
  const embedModel = (settings.embed_model || '').trim();

  const system = P.buildSystemPrompt({
    contact,
    user,
    group,
    settings,
    memory: group ? chat.memory : contact.memory,
  });

  // per-reply context rides at the end so the system prompt stays cacheable
  const remembered = await Memory.recall({ contactId: contact.id, chatId: chat.id, queries: recallQueries(chat), baseUrl, embedModel });
  const extras = [
    remembered.length ? `(Things you remember that may matter here:\n${remembered.map((m) => `- ${m}`).join('\n')})` : '',
    directive ? `(${directive})` : '',
    P.reminder({ contact, group, gap: quietGap(chat) }) || '',
  ].filter(Boolean);
  const hint = extras.join('\n\n');

  const numPredict = P.NUM_PREDICT[contact.length] || P.NUM_PREDICT.short;
  const numCtx = Math.max(1024, Number(settings.context_size) || 4096);
  const budget = Math.max(1500, (numCtx - numPredict - (system.length + hint.length) / 3.5 - 150) * 3.2);
  const vision = canSee(await modelCapabilities(baseUrl, contact.model));
  const history = buildHistory(chat, contact, userName, budget, vision);

  const messages = [{ role: 'system', content: system }, ...history];
  // A system message after the history confuses some chat templates (llama3
  // leaks its "assistant" header), so ride along on the last user turn instead.
  const tail = messages[messages.length - 1];
  if (hint) {
    if (tail.role === 'user') messages[messages.length - 1] = { ...tail, content: `${tail.content}\n\n${hint}` };
    else messages.push({ role: 'user', content: hint });
  }

  const stop = ['\nthem:', '\nyou:', `\n${userName}:`];
  if (group) for (const m of group.members) if (m.id !== contact.id) stop.push(`\n${m.name}:`);

  const options = {
    temperature: Number.isFinite(contact.temperature) ? contact.temperature : 0.8,
    top_p: 0.9,
    repeat_penalty: 1.1,
    num_predict: numPredict,
    num_ctx: numCtx,
    stop,
  };

  const base = { chat_id: chat.id, sender_id: contact.id };
  emit({ type: 'typing', ...base });
  if (settings.single_model !== '0') await unloadOthers(baseUrl, [contact.model, embedModel]);

  const splitting = style === 'texting';
  const saved = [];
  const filter = new ThinkFilter();
  let segment = '';
  let started = false;
  let reason = null;
  let errored = false;

  const finalize = (text, last) => {
    let t = P.cleanReply(text, { names: [contact.name], style });
    if (last && reason === 'length' && style !== 'raw') t = P.trimIncomplete(t);
    if (!t) return null;
    // only the first text of a reminder/check-in burst carries the label
    const msg = insertMessage({ chatId: chat.id, contact, role: 'assistant', content: t, kind: saved.length ? '' : kind });
    saved.push(msg);
    return msg;
  };

  const push = (visible) => {
    if (!visible) return;
    if (!started) {
      visible = visible.replace(/^\s+/, '');
      if (!visible) return;
      started = true;
    }
    segment += visible;
    emit({ type: 'token', ...base, text: visible });
    while (splitting && saved.length < MAX_BURST - 1) {
      const i = segment.indexOf('\n\n');
      if (i < 0) break;
      const head = segment.slice(0, i);
      segment = segment.slice(i).replace(/^\s+/, '');
      const msg = head.trim() ? finalize(head, false) : null;
      if (msg) emit({ type: 'message', ...base, message: msg, carry: segment });
    }
  };

  const run = async (msgs) => {
    for await (const part of streamChat({ baseUrl, model: contact.model, messages: msgs, options, signal })) {
      if (part.token) push(filter.push(part.token));
      if (part.done) reason = part.reason;
    }
  };

  try {
    await run(messages);
  } catch (err) {
    if (!signal.aborted) {
      const hadImages = messages.some((m) => m.images);
      let retryErr = err;
      if (!started && hadImages) {
        // model probably can't see images; retry text-only
        try {
          await run(messages.map(({ images, ...m }) => m));
          retryErr = null;
        } catch (e2) {
          retryErr = signal.aborted ? null : e2;
        }
      }
      if (retryErr) {
        errored = true;
        emit({ type: 'error', ...base, error: friendlyError(retryErr, contact.model, baseUrl) });
      }
    }
  }

  push(filter.flush());
  const last = finalize(segment, true); // on abort this keeps the partial text
  if (last) emit({ type: 'message', ...base, message: last, carry: '' });
  if (!saved.length && !signal.aborted && !errored) {
    emit({ type: 'error', ...base, error: `${contact.name} sent an empty reply. Try again or pick another model.` });
  }
  emit({ type: 'stop_typing', ...base });

  if (saved.length) {
    db.prepare(`UPDATE contacts SET last_activity_at = ${"strftime('%Y-%m-%dT%H:%M:%fZ','now')"} WHERE id = ?`).run(
      contact.id
    );
  }
  return saved;
}

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Who answers in a group: anyone @mentioned or named, whoever was replied to,
// otherwise one random member plus maybe a couple more.
function pickResponders(chat, members, { text = '', replyToSenderId = null, mode = 'reply' } = {}) {
  if (!members.length) return [];
  if (chat.kind === 'dm') return members;

  if (/(^|\s)@(all|everyone)\b/i.test(text)) return shuffle(members);

  // whoever is named first gets to answer first
  const picks = members
    .map((m) => {
      const full = m.name.toLowerCase().trim();
      const first = full.split(/\s+/)[0];
      const re = new RegExp(
        `(^|[^\\p{L}\\p{N}])@?(${P.escapeRe(full)}|${P.escapeRe(first)})(?![\\p{L}\\p{N}])`,
        'iu'
      );
      const match = re.exec(text);
      return { m, at: match ? match.index : -1 };
    })
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.m);
  const repliedTo = members.find((m) => m.id === replyToSenderId);
  if (repliedTo && !picks.includes(repliedTo)) picks.unshift(repliedTo);
  if (picks.length) return picks.slice(0, 4);

  const lastSpeaker = db
    .prepare("SELECT contact_id FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
    .get(chat.id)?.contact_id;
  let pool = shuffle(members.filter((m) => m.id !== lastSpeaker || mode !== 'continue'));
  if (!pool.length) pool = shuffle(members);

  const extra =
    mode === 'continue'
      ? Math.random() < 0.4
        ? 1
        : 0
      : pool.slice(1).filter(() => Math.random() < 0.45).length;
  return pool.slice(0, Math.min(1 + extra, 3));
}

// directive/kind apply to the first responder only (e.g. the one sending a reminder)
async function runTurn({ chat, responders, emit, signal, directive = '', kind = '' }) {
  const settings = getSettings();
  const group =
    chat.kind === 'group'
      ? {
          name: chat.name,
          description: chat.description,
          instructions: chat.instructions,
          members: chatMembers(chat),
        }
      : null;
  let first = true;
  for (const contact of responders) {
    if (signal.aborted) break;
    if (!first) await sleep(350 + Math.random() * 700, signal);
    first = false;
    if (signal.aborted) break;
    const firstTurn = contact === responders[0];
    await replyAs({
      chat: getChat(chat.id),
      contact,
      group,
      settings,
      emit,
      signal,
      directive: firstTurn ? directive : '',
      kind: firstTurn ? kind : '',
    });
  }
}

// ---------- Memory ----------

const summarizing = new Set();

function memoryEntries(memory) {
  return (memory || '')
    .split('\n\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function summarizeChat(chatId) {
  if (summarizing.has(chatId)) return;
  const chat = getChat(chatId);
  if (!chat) return;
  summarizing.add(chatId);
  try {
    const rows = db
      .prepare('SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id DESC LIMIT 30')
      .all(chatId, chat.summarized_id || 0)
      .reverse();
    if (rows.length < 4) return;

    const settings = getSettings();
    const userName = userLabel(settings);
    const isDm = chat.kind === 'dm';
    const writer = isDm ? getContact(chat.contact_id) : chatMembers(chat)[0];
    if (!writer) return;
    const existing = isDm ? writer.memory : chat.memory;

    const transcript = rows
      .map((r) => `${r.role === 'user' ? userName : r.sender_name || 'Someone'}: ${[attachmentSummary(r), r.content].filter(Boolean).join(' ')}`)
      .join('\n');
    const prompt =
      `Here is a recent text conversation${isDm ? '' : ` in the group chat "${chat.name}"`}:\n\n${transcript}\n\n` +
      `Write a memory note of 2-3 short sentences` +
      (isDm ? ` from ${writer.name}'s point of view (use "I" for ${writer.name})` : '') +
      ` covering the important facts: what was talked about, anything learned about ${userName}, and any plans or promises. Write only the note.`;

    const opts = { baseUrl: ollamaUrl(settings), model: writer.model };
    const embedModel = (settings.embed_model || '').trim();
    if (settings.single_model !== '0') await unloadOthers(opts.baseUrl, [writer.model, embedModel]);
    const numCtx = Math.max(2048, Number(settings.context_size) || 4096);
    const summary = await chatOnce({
      ...opts,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0.3, num_ctx: numCtx },
    });
    if (!summary) return;

    let entries = [...memoryEntries(existing), summary];
    if (entries.length > 5) {
      const old = entries.slice(0, entries.length - 4);
      const keep = entries.slice(-4);
      try {
        const consolidated = await chatOnce({
          ...opts,
          messages: [
            {
              role: 'user',
              content:
                'Merge these memory notes into one short note (2-4 sentences) that keeps the important facts. Write only the note.\n\n' +
                old.join('\n\n'),
            },
          ],
          options: { temperature: 0.3, num_ctx: numCtx },
        });
        entries = consolidated ? [consolidated, ...keep] : entries.slice(-5);
      } catch (err) {
        entries = entries.slice(-5);
      }
    }

    const memory = entries.join('\n\n');
    if (isDm) db.prepare('UPDATE contacts SET memory = ? WHERE id = ?').run(memory, writer.id);
    else db.prepare('UPDATE chats SET memory = ? WHERE id = ?').run(memory, chatId);
    db.prepare('UPDATE chats SET summarized_id = ? WHERE id = ?').run(rows[rows.length - 1].id, chatId);

    try {
      const facts = await Memory.extractFacts({ transcript, userName, writerName: writer.name, baseUrl: opts.baseUrl, model: writer.model, numCtx });
      if (facts.length) {
        await Memory.add({
          contactId: isDm ? writer.id : null,
          chatId: isDm ? null : chatId,
          texts: facts,
          baseUrl: opts.baseUrl,
          embedModel,
        });
      }
    } catch (err) {
      console.error('fact extraction failed for chat', chatId, err.message);
    }
  } catch (err) {
    console.error('summarize failed for chat', chatId, err.message);
  } finally {
    summarizing.delete(chatId);
  }
}

module.exports = {
  getSettings,
  ollamaUrl,
  userLabel,
  getChat,
  getContact,
  chatMembers,
  getMessage,
  insertMessage,
  serializeMessage,
  attachmentSummary,
  MESSAGE_SELECT,
  pickResponders,
  runTurn,
  summarizeChat,
  friendlyError,
  UPLOADS_DIR,
};
