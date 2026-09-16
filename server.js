const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { CharacterCard } = require('@lenml/char-card-reader');

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const PORT = process.env.PORT || 3210;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const uploadsDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\//.test(file.mimetype));
  },
});

// ---------- Settings ----------

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

function getOllamaUrl() {
  const url = getSettings().ollama_url;
  return url && url.trim() ? url.trim().replace(/\/+$/, '') : DEFAULT_OLLAMA_URL;
}

// ---------- Ollama helpers ----------

async function ollamaChat(model, messages, { stream } = { stream: false }) {
  return fetch(`${getOllamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream }),
  });
}

async function ollamaChatOnce(model, messages) {
  const resp = await ollamaChat(model, messages, { stream: false });
  if (!resp.ok) throw new Error(`Ollama error ${resp.status}`);
  const data = await resp.json();
  return data.message?.content?.trim() || '';
}

// ---------- Memory ----------

function memoryEntries(memory) {
  return (memory || '')
    .split('\n\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function summarizeContact(contactId) {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!contact) return;

  const recent = db
    .prepare('SELECT role, content FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 20')
    .all(contactId)
    .reverse();

  if (recent.length < 2) return;

  const prompt = [
    ...recent,
    {
      role: 'user',
      content:
        'Summarize what was just discussed in 2-3 short sentences, written as a memory note for yourself to reference later. Don\'t mention that this is a summary.',
    },
  ];

  let summary;
  try {
    summary = await ollamaChatOnce(contact.model, prompt);
  } catch (err) {
    console.error('summarize failed for contact', contactId, err.message);
    return;
  }
  if (!summary) return;

  let entries = [...memoryEntries(contact.memory), summary];

  if (entries.length > 5) {
    const old = entries.slice(0, entries.length - 4);
    const keep = entries.slice(-4);
    try {
      const consolidated = await ollamaChatOnce(contact.model, [
        {
          role: 'user',
          content:
            'Consolidate the following memory notes into a single short note (2-4 sentences) preserving the important facts:\n\n' +
            old.join('\n\n'),
        },
      ]);
      entries = consolidated ? [consolidated, ...keep] : [...old, ...keep].slice(-5);
    } catch (err) {
      console.error('consolidate failed for contact', contactId, err.message);
      entries = entries.slice(-5);
    }
  }

  db.prepare('UPDATE contacts SET memory = ? WHERE id = ?').run(entries.join('\n\n'), contactId);
}

// ---------- Contacts ----------

app.get('/api/contacts', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*,
        (SELECT content FROM messages m WHERE m.contact_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages m WHERE m.contact_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message_at
       FROM contacts c
       ORDER BY COALESCE(last_message_at, c.created_at) DESC`
    )
    .all();
  res.json(rows);
});

app.post('/api/contacts', (req, res) => {
  const { name, model, avatar_url, persona_prompt, first_message } = req.body || {};
  if (!name || !name.trim() || !model) {
    return res.status(400).json({ error: 'name and model are required' });
  }
  const info = db
    .prepare('INSERT INTO contacts (name, model, avatar_url, persona_prompt) VALUES (?, ?, ?, ?)')
    .run(name.trim(), model, avatar_url || '', persona_prompt || '');

  if (first_message && first_message.trim()) {
    db.prepare('INSERT INTO messages (contact_id, role, content) VALUES (?, ?, ?)').run(
      info.lastInsertRowid,
      'assistant',
      first_message.trim()
    );
  }

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(contact);
});

app.put('/api/contacts/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const name = req.body?.name?.trim() || existing.name;
  const model = req.body?.model || existing.model;
  const avatar_url = req.body?.avatar_url !== undefined ? req.body.avatar_url : existing.avatar_url;
  const persona_prompt =
    req.body?.persona_prompt !== undefined ? req.body.persona_prompt : existing.persona_prompt;

  db.prepare('UPDATE contacts SET name = ?, model = ?, avatar_url = ?, persona_prompt = ? WHERE id = ?').run(
    name,
    model,
    avatar_url,
    persona_prompt,
    id
  );
  res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
});

app.delete('/api/contacts/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM contacts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  db.prepare('DELETE FROM messages WHERE contact_id = ?').run(id);
  db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
  res.status(204).end();
});

// ---------- Messages ----------

app.get('/api/contacts/:id/messages', (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare('SELECT * FROM messages WHERE contact_id = ? ORDER BY id ASC')
    .all(id);
  res.json(rows);
});

app.post('/api/contacts/:id/messages', async (req, res) => {
  const id = Number(req.params.id);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!contact) return res.status(404).json({ error: 'contact not found' });

  const content = (req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'content is required' });

  db.prepare('INSERT INTO messages (contact_id, role, content) VALUES (?, ?, ?)').run(
    id,
    'user',
    content
  );
  db.prepare("UPDATE contacts SET last_activity_at = datetime('now') WHERE id = ?").run(id);

  const history = db
    .prepare('SELECT role, content FROM messages WHERE contact_id = ? ORDER BY id ASC')
    .all(id);

  const ollamaMessages = [];
  if (contact.persona_prompt) {
    ollamaMessages.push({ role: 'system', content: contact.persona_prompt });
  }
  if (contact.memory) {
    ollamaMessages.push({
      role: 'system',
      content: `Relevant memory from past conversations with this person:\n${contact.memory}`,
    });
  }
  ollamaMessages.push(...history);

  let ollamaResp;
  try {
    ollamaResp = await ollamaChat(contact.model, ollamaMessages, { stream: true });
  } catch (err) {
    return res.status(502).json({ error: `Could not reach Ollama: ${err.message}` });
  }

  if (!ollamaResp.ok || !ollamaResp.body) {
    return res.status(502).json({ error: `Ollama error ${ollamaResp.status}` });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const reader = ollamaResp.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const token = obj.message?.content || '';
        if (token) {
          full += token;
          res.write(token);
        }
      }
    }
  } catch (err) {
    console.error('stream error', err.message);
  }

  res.end();

  if (full.trim()) {
    db.prepare('INSERT INTO messages (contact_id, role, content) VALUES (?, ?, ?)').run(
      id,
      'assistant',
      full.trim()
    );
    db.prepare("UPDATE contacts SET last_activity_at = datetime('now') WHERE id = ?").run(id);
  }
});

app.post('/api/contacts/:id/summarize', async (req, res) => {
  const id = Number(req.params.id);
  res.status(202).end();
  summarizeContact(id).catch((err) => console.error('summarize error', err.message));
});

// ---------- Ollama proxy ----------

app.get('/api/models', async (req, res) => {
  try {
    const resp = await fetch(`${getOllamaUrl()}/api/tags`);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const models = (data.models || []).map((m) => m.name || m.model);
    res.json(models);
  } catch (err) {
    res.status(502).json({ error: `Could not reach Ollama: ${err.message}` });
  }
});

// ---------- Settings ----------

app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

const SETTINGS_KEYS = ['theme', 'dark_mode', 'wallpaper_url', 'ollama_url'];

app.patch('/api/settings', (req, res) => {
  const upsert = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
  for (const key of SETTINGS_KEYS) {
    if (req.body && req.body[key] !== undefined) {
      upsert.run(key, String(req.body[key]));
    }
  }
  res.json(getSettings());
});

// ---------- Uploads ----------

app.post('/api/upload/avatar', upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no image uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.post('/api/upload/wallpaper', upload.single('wallpaper'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no image uploaded' });
  const url = `/uploads/${req.file.filename}`;
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run('wallpaper_url', url);
  res.json({ url });
});

// ---------- Character Card import ----------

const PERSONA_FIELD_ORDER = ['description', 'personality', 'scenario', 'system_prompt', 'mes_example'];

app.post('/api/cards/parse', upload.single('card'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no card image uploaded' });

  try {
    const buf = fs.readFileSync(req.file.path);
    const card = await CharacterCard.from_file(buf);
    const v3 = card.toSpecV3().data;

    if (!card.name) {
      throw new Error('no character card data found in this image');
    }

    const persona_prompt = PERSONA_FIELD_ORDER.map((key) => (v3[key] || '').trim())
      .filter(Boolean)
      .join('\n\n');

    res.json({
      name: card.name,
      avatar_url: `/uploads/${req.file.filename}`,
      persona_prompt,
      first_message: card.first_message || '',
    });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: `Could not read character card: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`humanchat running at http://127.0.0.1:${PORT}`);
});
