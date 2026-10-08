const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const E = require('./engine');
const Files = require('./files');
const Turns = require('./turns');
const Web = require('./web');
const Memory = require('./memory');
const Reminders = require('./reminders');
const Scheduler = require('./scheduler');
const P = require('./prompts');
const { CharacterCard } = require('@lenml/char-card-reader');

const PORT = Number(process.env.PORT) || 3210;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '1mb' }));

// When bound to loopback, refuse other Host headers so a malicious web page
// can't reach the API through DNS rebinding.
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$/i;
if (LOOPBACK.test(HOST) || HOST === '::1') {
  app.use((req, res, next) => (LOOPBACK.test(req.headers.host || '') ? next() : res.status(403).end()));
}
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // uploaded code/text files are shown as plain text, never run as scripts or styles
  if (req.path.startsWith('/uploads/') && Files.kindOf(req.path) === 'text') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Uploads ----------

fs.mkdirSync(E.UPLOADS_DIR, { recursive: true });

const IMAGE_EXT = /^\.(png|jpe?g|gif|webp)$/i;
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, E.UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\//.test(file.mimetype) && IMAGE_EXT.test(path.extname(file.originalname)));
  },
});

const uploadUrl = (file) => `/uploads/${file.filename}`;

for (const field of ['avatar', 'image']) {
  app.post(`/api/upload/${field}`, upload.single(field), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Please pick a PNG, JPG, GIF or WebP image' });
    res.json({ url: uploadUrl(req.file) });
  });
}

// Chat attachments: images, PDFs, Word docs, text and code files.
const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, E.UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!Files.kindOf(file.originalname)),
});

app.post('/api/upload/file', attachmentUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Unsupported file. Try an image, PDF, Word (.docx), text or code file.' });
  }
  // multer decodes multipart filenames as latin1
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 200);
  const kind = Files.kindOf(name);
  let extracted = { text: '', pages: 0 };
  let warning = '';
  if (kind !== 'image') {
    try {
      extracted = await Files.extractText(req.file.path, kind);
    } catch (err) {
      console.error('extract failed', name, err.message);
      warning = `Couldn't read the text inside ${name}`;
    }
    if (!warning && !extracted.text.trim()) {
      warning = kind === 'pdf' ? `${name} has no selectable text (scanned PDF?). Only its name will be shared.` : `${name} looks empty`;
    }
  }
  const info = db
    .prepare('INSERT INTO files (url, name, mime, size, kind, text, pages) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uploadUrl(req.file), name, req.file.mimetype, req.file.size, kind, extracted.text, extracted.pages);
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(info.lastInsertRowid));
  res.json({
    id: file.id,
    url: file.url,
    name: file.name,
    kind: file.kind,
    mime: file.mime,
    size: file.size,
    pages: file.pages,
    text_chars: file.text.length,
    warning,
  });
});

app.post('/api/upload/wallpaper', upload.single('wallpaper'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please pick a PNG, JPG, GIF or WebP image' });
  const url = uploadUrl(req.file);
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('wallpaper_url', url);
  res.json({ url });
});

// ---------- Helpers ----------

const id = (req) => Number(req.params.id);
const str = (v, max = 20000) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);

function pickContactFields(body, existing = {}) {
  const out = {};
  const textFields = { name: 80, avatar_url: 500, model: 200, persona_prompt: 20000, about: 500, status: 120, color: 20, memory: 20000 };
  for (const [key, max] of Object.entries(textFields)) {
    out[key] = body[key] !== undefined ? str(body[key], max).trim() : existing[key] ?? '';
  }
  out.style = ['texting', 'roleplay', 'raw'].includes(body.style) ? body.style : existing.style || 'texting';
  out.length = ['short', 'normal', 'long'].includes(body.length) ? body.length : existing.length || 'short';
  out.initiative = ['off', 'sometimes', 'often'].includes(body.initiative) ? body.initiative : existing.initiative || 'sometimes';
  const t = Number(body.temperature);
  out.temperature = Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : existing.temperature ?? 0.8;
  return out;
}

function contactRow(c) {
  if (!c) return null;
  const chat = db.prepare("SELECT id FROM chats WHERE kind = 'dm' AND contact_id = ?").get(c.id);
  return { ...c, dm_chat_id: chat ? chat.id : null };
}

const memberInfo = (c) => ({ id: c.id, name: c.name, avatar_url: c.avatar_url, color: c.color, model: c.model });

function chatRow(ch) {
  if (!ch) return null;
  const last = db
    .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1')
    .get(ch.id);
  const unread = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND role = 'assistant' AND id > ?")
    .get(ch.id, ch.last_read_id || 0).n;
  const members = E.chatMembers(ch);
  const base = {
    id: ch.id,
    kind: ch.kind,
    pinned: !!ch.pinned,
    muted: !!ch.muted,
    busy: Turns.isBusy(ch.id),
    unread,
    created_at: ch.created_at,
    last_message: last
      ? {
          id: last.id,
          role: last.role,
          sender_name: last.sender_name,
          content: last.content,
          attachment: E.attachmentSummary(last),
          created_at: last.created_at,
        }
      : null,
    members: members.map(memberInfo),
  };
  if (ch.kind === 'dm') {
    const c = members[0] || {};
    return { ...base, contact_id: ch.contact_id, name: c.name, avatar_url: c.avatar_url, color: c.color, about: c.about, status: c.status, model: c.model };
  }
  return {
    ...base,
    name: ch.name,
    avatar_url: ch.avatar_url,
    description: ch.description,
    instructions: ch.instructions,
    memory: ch.memory,
  };
}

function listChats() {
  return db
    .prepare('SELECT * FROM chats')
    .all()
    .map(chatRow)
    .sort(
      (a, b) =>
        b.pinned - a.pinned ||
        (b.last_message?.created_at || b.created_at).localeCompare(a.last_message?.created_at || a.created_at)
    );
}

function requireChat(req, res) {
  const chat = E.getChat(id(req));
  if (!chat) res.status(404).json({ error: 'chat not found' });
  return chat;
}

function setMembers(chatId, memberIds) {
  db.prepare('DELETE FROM chat_members WHERE chat_id = ?').run(chatId);
  const ins = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, contact_id) VALUES (?, ?)');
  for (const cid of memberIds) if (E.getContact(cid)) ins.run(chatId, cid);
}

// ---------- Contacts ----------

app.get('/api/contacts', (req, res) => {
  res.json(db.prepare('SELECT * FROM contacts ORDER BY name COLLATE NOCASE').all().map(contactRow));
});

app.post('/api/contacts', (req, res) => {
  const body = req.body || {};
  const f = pickContactFields(body);
  if (!f.name || !f.model) return res.status(400).json({ error: 'name and model are required' });

  const contact = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO contacts (name, model, avatar_url, persona_prompt, about, status, color, style, length, temperature, memory, initiative)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(f.name, f.model, f.avatar_url, f.persona_prompt, f.about, f.status, f.color, f.style, f.length, f.temperature, f.memory, f.initiative);
    const cid = Number(info.lastInsertRowid);
    const chatId = db.ensureDmChat(cid);
    const c = E.getContact(cid);
    const first = str(body.first_message).trim();
    if (first) E.insertMessage({ chatId, contact: c, role: 'assistant', content: first });
    return c;
  });
  res.status(201).json(contactRow(contact));
});

app.put('/api/contacts/:id', (req, res) => {
  const existing = E.getContact(id(req));
  if (!existing) return res.status(404).json({ error: 'not found' });
  const f = pickContactFields(req.body || {}, existing);
  if (!f.name) f.name = existing.name;
  if (!f.model) f.model = existing.model;
  db.prepare(
    `UPDATE contacts SET name = ?, model = ?, avatar_url = ?, persona_prompt = ?, about = ?, status = ?, color = ?,
       style = ?, length = ?, temperature = ?, memory = ?, initiative = ? WHERE id = ?`
  ).run(f.name, f.model, f.avatar_url, f.persona_prompt, f.about, f.status, f.color, f.style, f.length, f.temperature, f.memory, f.initiative, existing.id);
  if (f.initiative !== existing.initiative) db.prepare("UPDATE chats SET next_checkin_at = NULL WHERE kind = 'dm' AND contact_id = ?").run(existing.id);
  if (f.name !== existing.name) {
    db.prepare('UPDATE messages SET sender_name = ? WHERE contact_id = ?').run(f.name, existing.id);
  }
  res.json(contactRow(E.getContact(existing.id)));
});

app.delete('/api/contacts/:id', (req, res) => {
  const cid = id(req);
  if (!E.getContact(cid)) return res.status(404).json({ error: 'not found' });
  db.transaction(() => {
    const dm = db.prepare("SELECT id FROM chats WHERE kind = 'dm' AND contact_id = ?").get(cid);
    if (dm) {
      db.prepare('DELETE FROM messages WHERE chat_id = ?').run(dm.id);
      db.prepare('DELETE FROM reminders WHERE chat_id = ?').run(dm.id);
      db.prepare('DELETE FROM chats WHERE id = ?').run(dm.id);
    }
    db.prepare('DELETE FROM chat_members WHERE contact_id = ?').run(cid);
    // keep their lines in group chats, just detached from the persona
    db.prepare('UPDATE messages SET contact_id = NULL WHERE contact_id = ?').run(cid);
    db.prepare('DELETE FROM memories WHERE contact_id = ?').run(cid);
    db.prepare('UPDATE reminders SET contact_id = NULL WHERE contact_id = ?').run(cid);
    db.prepare('DELETE FROM contacts WHERE id = ?').run(cid);
  });
  res.status(204).end();
});

// ---------- Chats ----------

app.get('/api/chats', (req, res) => res.json(listChats()));

app.get('/api/chats/:id', (req, res) => {
  const chat = requireChat(req, res);
  if (chat) res.json(chatRow(chat));
});

app.post('/api/chats', (req, res) => {
  const body = req.body || {};
  const name = str(body.name, 80).trim();
  const memberIds = Array.isArray(body.member_ids) ? body.member_ids.map(Number) : [];
  if (!name) return res.status(400).json({ error: 'Give the group a name' });
  if (!memberIds.length) return res.status(400).json({ error: 'Add at least one member' });

  const chatId = db.transaction(() => {
    const info = db
      .prepare("INSERT INTO chats (kind, name, avatar_url, description, instructions) VALUES ('group', ?, ?, ?, ?)")
      .run(name, str(body.avatar_url, 500), str(body.description, 500), str(body.instructions));
    const cid = Number(info.lastInsertRowid);
    setMembers(cid, memberIds);
    return cid;
  });
  res.status(201).json(chatRow(E.getChat(chatId)));
});

app.put('/api/chats/:id', (req, res) => {
  const chat = requireChat(req, res);
  if (!chat) return;
  const b = req.body || {};
  const val = (key, max) => (b[key] !== undefined ? str(b[key], max) : chat[key]);
  const flag = (key) => (b[key] !== undefined ? (b[key] ? 1 : 0) : chat[key]);

  if (chat.kind === 'group') {
    const name = val('name', 80).trim() || chat.name;
    db.prepare(
      'UPDATE chats SET name = ?, avatar_url = ?, description = ?, instructions = ?, memory = ? WHERE id = ?'
    ).run(name, val('avatar_url', 500), val('description', 500), val('instructions'), val('memory'), chat.id);
    if (Array.isArray(b.member_ids)) {
      if (!b.member_ids.length) return res.status(400).json({ error: 'A group needs at least one member' });
      setMembers(chat.id, b.member_ids.map(Number));
    }
  }
  db.prepare('UPDATE chats SET pinned = ?, muted = ? WHERE id = ?').run(flag('pinned'), flag('muted'), chat.id);
  res.json(chatRow(E.getChat(chat.id)));
});

app.delete('/api/chats/:id', (req, res) => {
  const chat = requireChat(req, res);
  if (!chat) return;
  if (chat.kind === 'dm') return res.status(400).json({ error: 'Delete the contact to remove a direct chat' });
  db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chat.id);
    db.prepare('DELETE FROM chat_members WHERE chat_id = ?').run(chat.id);
    db.prepare('DELETE FROM reminders WHERE chat_id = ?').run(chat.id);
    db.prepare('DELETE FROM memories WHERE chat_id = ?').run(chat.id);
    db.prepare('DELETE FROM chats WHERE id = ?').run(chat.id);
  });
  res.status(204).end();
});

app.post('/api/chats/:id/clear', (req, res) => {
  const chat = requireChat(req, res);
  if (!chat) return;
  db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chat.id);
  db.prepare('UPDATE chats SET summarized_id = 0 WHERE id = ?').run(chat.id);
  res.status(204).end();
});

app.post('/api/chats/:id/read', (req, res) => {
  const chat = requireChat(req, res);
  if (!chat) return;
  const upto =
    Number(req.body?.message_id) ||
    db.prepare('SELECT MAX(id) AS m FROM messages WHERE chat_id = ?').get(chat.id).m ||
    0;
  db.prepare('UPDATE chats SET last_read_id = MAX(last_read_id, ?) WHERE id = ?').run(upto, chat.id);
  res.status(204).end();
});

app.get('/api/chats/:id/messages', (req, res) => {
  const chat = requireChat(req, res);
  if (!chat) return;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 150));
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = db
    .prepare(`${E.MESSAGE_SELECT} WHERE m.chat_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
    .all(chat.id, before, limit + 1);
  const has_more = rows.length > limit;
  res.json({ messages: rows.slice(0, limit).reverse().map(E.serializeMessage), has_more });
});

app.get('/api/chats/:id/search', (req, res) => {
  const chat = requireChat(req, res);
  if (!chat) return;
  const q = str(req.query.q, 200).trim();
  if (!q) return res.json([]);
  const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const rows = db
    .prepare(`${E.MESSAGE_SELECT} WHERE m.chat_id = ? AND m.content LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT 100`)
    .all(chat.id, like);
  res.json(rows.map(E.serializeMessage));
});

app.get('/api/chats/:id/export', (req, res) => {
  const chat = requireChat(req, res);
  if (!chat) return;
  const row = chatRow(chat);
  const msgs = db
    .prepare(`${E.MESSAGE_SELECT} WHERE m.chat_id = ? ORDER BY m.id ASC`)
    .all(chat.id)
    .map(E.serializeMessage);
  const safe = (row.name || 'chat').replace(/[^\w.-]+/g, '_');
  if (req.query.format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.json"`);
    return res.json({ chat: row, messages: msgs });
  }
  const me = E.userLabel(E.getSettings());
  const text = msgs
    .map((m) => {
      const who = m.role === 'user' ? me : m.sender_name || row.name;
      const files = m.attachments.map((f) => `[${f.kind === 'image' ? 'photo' : 'file'}: ${f.name} ${f.url}]`);
      const body = [...files, m.content].filter(Boolean).join(' ');
      return `[${m.created_at.replace('T', ' ').slice(0, 16)}] ${who}: ${body}`;
    })
    .join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.txt"`);
  res.send(text + '\n');
});

app.post('/api/chats/:id/summarize', (req, res) => {
  const chat = E.getChat(id(req));
  res.status(202).end();
  if (chat) E.summarizeChat(chat.id);
});

// ---------- Generation (streamed as NDJSON events) ----------

app.get('/api/events', (req, res) => Turns.subscribe(req, res));

// Builds the one-off instruction for a user message: /search results, a new
// reminder, or the text of a pasted link.
async function prepareUserTurn({ chat, message, content, isSearch, responders, emit }) {
  const settings = E.getSettings();
  const userName = E.userLabel(settings);
  const first = responders[0];

  if (isSearch) {
    emit({ type: 'status', chat_id: chat.id, text: 'searching the web…' });
    let meta;
    let directive;
    try {
      const results = (await Web.search(content, settings)).slice(0, 5);
      let page = null;
      for (const r of results.slice(0, 2)) {
        try {
          page = await Web.readPage(r.url, 1800);
          if (page.text.length > 300) break;
        } catch {}
      }
      meta = { search: { query: content, results } };
      directive = results.length
        ? P.directives.searched(userName, content, results, page?.text.length > 300 ? page : null)
        : P.directives.searchFailed(userName, content, 'no results');
    } catch (err) {
      meta = { search: { query: content, results: [], error: err.message } };
      directive = P.directives.searchFailed(userName, content, err.message);
    }
    db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), message.id);
    emit({ type: 'message_updated', chat_id: chat.id, message: E.getMessage(message.id) });
    return directive;
  }

  const reminder = first && Reminders.parseReminder(content);
  if (reminder) {
    if (!reminder.due) return P.directives.reminderNoTime(userName, reminder.text);
    const info = db
      .prepare('INSERT INTO reminders (chat_id, contact_id, text, due_at) VALUES (?, ?, ?, ?)')
      .run(chat.id, first.id, reminder.text, reminder.due.toISOString());
    emit({ type: 'reminder_set', chat_id: chat.id, reminder: reminderRow(Number(info.lastInsertRowid)) });
    return P.directives.reminderSet(userName, reminder.text, Reminders.formatDue(reminder.due));
  }

  const urls = settings.read_links !== '0' ? Web.findUrls(content) : [];
  if (urls.length) {
    emit({ type: 'status', chat_id: chat.id, text: 'opening the link…' });
    const pages = (await Promise.all(urls.map((u) => Web.readPage(u, 1500).catch(() => null)))).filter((p) => p?.text);
    if (pages.length) return P.directives.link(userName, pages);
  }
  return '';
}

app.post('/api/chats/:id/messages', (req, res) => {
  const chat = requireChat(req, res);
  if (!chat) return;
  let content = str(req.body?.content).trim();
  const isSearch = /^\/search(\s|$)/i.test(content);
  if (isSearch) {
    content = content.replace(/^\/search\s*/i, '').trim();
    if (!content) return res.status(400).json({ error: 'What should I look up? Try: /search weather in Mumbai' });
  }
  const fileIds = (Array.isArray(req.body?.attachments) ? req.body.attachments : [])
    .map(Number)
    .filter((fid) => db.prepare('SELECT 1 FROM files WHERE id = ?').get(fid))
    .slice(0, 10);
  if (!content && !fileIds.length) return res.status(400).json({ error: 'message is empty' });

  let replyTo = Number(req.body?.reply_to) || null;
  const replied = replyTo ? db.prepare('SELECT * FROM messages WHERE id = ? AND chat_id = ?').get(replyTo, chat.id) : null;
  if (!replied) replyTo = null;

  const members = E.chatMembers(chat);
  if (!members.length) return res.status(400).json({ error: 'Nobody is in this chat' });

  Turns.streamTurn(req, res, chat, async (emit) => {
    const message = E.insertMessage({
      chatId: chat.id,
      role: 'user',
      content,
      attachments: fileIds,
      replyTo,
      kind: isSearch ? 'search' : '',
    });
    db.prepare('UPDATE chats SET last_read_id = ?, next_checkin_at = NULL WHERE id = ?').run(message.id, chat.id);
    emit({ type: 'user_message', chat_id: chat.id, message });
    const responders = E.pickResponders(chat, members, { text: content, replyToSenderId: replied?.contact_id });
    const directive = await prepareUserTurn({ chat, message, content, isSearch, responders, emit });
    return { responders, directive };
  });
});

// "Double text" in a DM, or let the group keep talking among themselves.
app.post('/api/chats/:id/continue', (req, res) => {
  const chat = requireChat(req, res);
  if (!chat) return;
  const members = E.chatMembers(chat);
  if (!members.length) return res.status(400).json({ error: 'Nobody is in this chat' });
  const wanted = Number(req.body?.sender_id);
  Turns.streamTurn(req, res, chat, () => {
    const chosen = members.find((m) => m.id === wanted);
    return { responders: chosen ? [chosen] : E.pickResponders(chat, members, { mode: 'continue' }) };
  });
});

// Throw away the latest reply burst and generate it again.
app.post('/api/chats/:id/regenerate', (req, res) => {
  const chat = requireChat(req, res);
  if (!chat) return;
  if (Turns.isBusy(chat.id)) return res.status(409).json({ error: 'Still replying, hang on a sec' });

  const lastUser = db
    .prepare("SELECT * FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1")
    .get(chat.id);
  const burst = db
    .prepare("SELECT id, contact_id FROM messages WHERE chat_id = ? AND role = 'assistant' AND id > ? ORDER BY id")
    .all(chat.id, lastUser?.id || 0);
  const members = E.chatMembers(chat);
  const senders = [...new Set(burst.map((m) => m.contact_id))]
    .map((cid) => members.find((m) => m.id === cid))
    .filter(Boolean);
  const responders = senders.length ? senders : E.pickResponders(chat, members, {});
  if (!responders.length) return res.status(400).json({ error: 'Nobody to reply' });

  // a regenerated search answer reuses the results it already found
  let directive = '';
  const search = lastUser?.kind === 'search' ? JSON.parse(lastUser.meta || '{}').search : null;
  if (search?.results?.length) directive = P.directives.searched(E.userLabel(E.getSettings()), search.query, search.results, null);

  Turns.streamTurn(req, res, chat, (emit) => {
    const del = db.prepare('DELETE FROM messages WHERE id = ?');
    for (const m of burst) del.run(m.id);
    emit({ type: 'removed', chat_id: chat.id, ids: burst.map((m) => m.id) });
    return { responders, directive };
  });
});

app.post('/api/chats/:id/stop', (req, res) => {
  Turns.stop(id(req));
  res.status(204).end();
});

// ---------- Reminders ----------

function reminderRow(rid) {
  const r = db
    .prepare('SELECT r.*, c.name AS contact_name FROM reminders r LEFT JOIN contacts c ON c.id = r.contact_id WHERE r.id = ?')
    .get(rid);
  return r ? { ...r, done: !!r.done } : null;
}

app.get('/api/reminders', (req, res) => {
  const chatId = Number(req.query.chat_id) || null;
  const rows = db
    .prepare(
      `SELECT r.*, c.name AS contact_name FROM reminders r LEFT JOIN contacts c ON c.id = r.contact_id
       WHERE r.done = 0 ${chatId ? 'AND r.chat_id = ?' : ''} ORDER BY r.due_at`
    )
    .all(...(chatId ? [chatId] : []));
  res.json(rows);
});

app.post('/api/reminders', (req, res) => {
  const chat = E.getChat(Number(req.body?.chat_id));
  if (!chat) return res.status(404).json({ error: 'chat not found' });
  const text = str(req.body?.text, 300).trim();
  const due = new Date(req.body?.due_at);
  if (!text) return res.status(400).json({ error: 'What should they remind you about?' });
  if (Number.isNaN(due.getTime()) || due <= new Date()) return res.status(400).json({ error: 'Pick a time in the future' });
  const sender = E.chatMembers(chat)[0];
  const info = db
    .prepare('INSERT INTO reminders (chat_id, contact_id, text, due_at) VALUES (?, ?, ?, ?)')
    .run(chat.id, sender?.id ?? null, text, due.toISOString());
  res.status(201).json(reminderRow(Number(info.lastInsertRowid)));
});

app.delete('/api/reminders/:id', (req, res) => {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(id(req));
  res.status(204).end();
});

// ---------- Long-term memory ----------

function memoryScope(req) {
  return req.params.kind === 'contacts' ? { contactId: id(req) } : { chatId: id(req) };
}

app.get('/api/:kind(contacts|chats)/:id/memories', (req, res) => res.json(Memory.list(memoryScope(req))));

app.post('/api/:kind(contacts|chats)/:id/memories', async (req, res) => {
  const text = str(req.body?.text, 400).trim();
  if (!text) return res.status(400).json({ error: 'empty memory' });
  const settings = E.getSettings();
  await Memory.add({ ...memoryScope(req), texts: [text], source: 'manual', baseUrl: E.ollamaUrl(settings), embedModel: (settings.embed_model || '').trim() });
  res.status(201).json(Memory.list(memoryScope(req)));
});

app.delete('/api/memories/:id', (req, res) => {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id(req));
  res.status(204).end();
});

// ---------- Single messages ----------

function requireMessage(req, res) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id(req));
  if (!m) res.status(404).json({ error: 'message not found' });
  return m;
}

app.put('/api/messages/:id', (req, res) => {
  const m = requireMessage(req, res);
  if (!m) return;
  const content = str(req.body?.content).trim();
  if (!content && JSON.parse(m.attachments || '[]').length === 0) return res.status(400).json({ error: 'message is empty' });
  db.prepare('UPDATE messages SET content = ?, edited = 1 WHERE id = ?').run(content, m.id);
  res.json(E.getMessage(m.id));
});

app.delete('/api/messages/:id', (req, res) => {
  const m = requireMessage(req, res);
  if (!m) return;
  db.prepare('DELETE FROM messages WHERE id = ?').run(m.id);
  res.status(204).end();
});

app.post('/api/messages/:id/react', (req, res) => {
  const m = requireMessage(req, res);
  if (!m) return;
  const emoji = str(req.body?.emoji, 16).trim();
  if (!emoji) return res.status(400).json({ error: 'emoji required' });
  let reactions = [];
  try {
    reactions = JSON.parse(m.reactions || '[]');
  } catch {}
  reactions = reactions.includes(emoji) ? reactions.filter((e) => e !== emoji) : [...reactions, emoji].slice(-6);
  db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(JSON.stringify(reactions), m.id);
  res.json(E.getMessage(m.id));
});

// ---------- Ollama ----------

app.get('/api/models', async (req, res) => {
  try {
    const resp = await fetch(`${E.ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const models = (data.models || [])
      .map((m) => ({
        name: m.name || m.model,
        size: m.size,
        params: m.details?.parameter_size || '',
        family: m.details?.family || '',
      }))
      .filter((m) => !/embed/i.test(m.family + m.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const { modelCapabilities, canSee } = require('./ollama');
    for (const m of models) m.vision = canSee(await modelCapabilities(E.ollamaUrl(), m.name));
    res.json(models);
  } catch (err) {
    res.status(502).json({ error: `Could not reach Ollama at ${E.ollamaUrl()}` });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const resp = await fetch(`${E.ollamaUrl()}/api/version`, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();
    const embedModel = (E.getSettings().embed_model || '').trim();
    let embed_ok = false;
    if (embedModel) {
      try {
        const tags = await (await fetch(`${E.ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(3000) })).json();
        const want = embedModel.includes(':') ? embedModel : `${embedModel}:latest`;
        embed_ok = (tags.models || []).some((m) => m.name === want || m.name === embedModel);
      } catch {}
    }
    res.json({ ok: resp.ok, version: data.version || '', embed_model: embedModel, embed_ok });
  } catch {
    res.json({ ok: false });
  }
});

// ---------- Settings ----------

app.get('/api/settings', (req, res) => res.json(E.getSettings()));

app.patch('/api/settings', (req, res) => {
  const upsert = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
  for (const key of Object.keys(db.settingsDefaults)) {
    if (req.body && req.body[key] !== undefined) upsert.run(key, str(req.body[key]));
  }
  res.json(E.getSettings());
});

app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="chatboard-backup.json"');
  res.json({
    exported_at: new Date().toISOString(),
    settings: E.getSettings(),
    contacts: db.prepare('SELECT * FROM contacts').all(),
    chats: db.prepare('SELECT * FROM chats').all(),
    chat_members: db.prepare('SELECT * FROM chat_members').all(),
    messages: db.prepare('SELECT * FROM messages ORDER BY id').all(),
    reminders: db.prepare('SELECT * FROM reminders ORDER BY id').all(),
    memories: db.prepare('SELECT id, contact_id, chat_id, text, source, created_at FROM memories ORDER BY id').all(),
    files: db.prepare('SELECT * FROM files ORDER BY id').all(),
  });
});

// ---------- Character card import ----------

const PERSONA_FIELD_ORDER = ['description', 'personality', 'scenario', 'system_prompt', 'mes_example'];

app.post('/api/cards/parse', upload.single('card'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no card image uploaded' });
  try {
    const card = await CharacterCard.from_file(fs.readFileSync(req.file.path));
    if (!card.name) throw new Error('no character card data found in this image');
    const v3 = card.toSpecV3().data;
    const persona_prompt = PERSONA_FIELD_ORDER.map((key) => (v3[key] || '').trim())
      .filter(Boolean)
      .join('\n\n');
    res.json({
      name: card.name,
      avatar_url: uploadUrl(req.file),
      persona_prompt,
      first_message: card.first_message || '',
    });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: `Could not read character card: ${err.message}` });
  }
});

// ---------- Errors ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too big' : err.message });
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'server error' });
});

Scheduler.start();

app.listen(PORT, HOST, () => {
  console.log(`Chatboard running at http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`);
});
