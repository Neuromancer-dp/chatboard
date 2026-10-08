const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.resolve(__dirname, process.env.CHATBOARD_DB || 'chatboard.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- Tables ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    avatar_url TEXT DEFAULT '',
    model TEXT NOT NULL,
    persona_prompt TEXT DEFAULT '',
    about TEXT DEFAULT '',
    status TEXT DEFAULT '',
    color TEXT DEFAULT '',
    temperature REAL DEFAULT 0.8,
    style TEXT DEFAULT 'texting',       -- texting | roleplay | raw
    length TEXT DEFAULT 'short',        -- short | normal | long
    initiative TEXT DEFAULT 'sometimes', -- texts you first: off | sometimes | often
    memory TEXT DEFAULT '',             -- rolling conversation notes
    last_activity_at TEXT DEFAULT (${NOW}),
    created_at TEXT DEFAULT (${NOW})
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'dm',    -- 'dm' | 'group'
    contact_id INTEGER,                 -- dm only
    name TEXT DEFAULT '',               -- group only
    avatar_url TEXT DEFAULT '',         -- group only
    description TEXT DEFAULT '',        -- group only
    instructions TEXT DEFAULT '',       -- group scenario / ground rules
    memory TEXT DEFAULT '',             -- group only (dm notes live on the contact)
    pinned INTEGER DEFAULT 0,
    muted INTEGER DEFAULT 0,
    last_read_id INTEGER DEFAULT 0,
    summarized_id INTEGER DEFAULT 0,
    next_checkin_at TEXT,               -- when the contact plans to text first
    created_at TEXT DEFAULT (${NOW})
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_dm ON chats(contact_id) WHERE kind = 'dm';

  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id INTEGER NOT NULL,
    contact_id INTEGER NOT NULL,
    PRIMARY KEY (chat_id, contact_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    contact_id INTEGER,                 -- sender persona; NULL for the user (or a deleted contact)
    sender_name TEXT DEFAULT '',        -- snapshot, survives contact deletion
    role TEXT NOT NULL,                 -- 'user' | 'assistant'
    content TEXT NOT NULL DEFAULT '',
    attachments TEXT DEFAULT '[]',      -- JSON array of file ids
    reply_to INTEGER,
    reactions TEXT DEFAULT '[]',
    kind TEXT DEFAULT '',               -- '' | 'search' | 'reminder' | 'checkin'
    meta TEXT DEFAULT '{}',             -- e.g. web search sources
    edited INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (${NOW})
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

  -- uploaded attachments; text is extracted once at upload time (pdf, docx, text/code)
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    name TEXT DEFAULT '',
    mime TEXT DEFAULT '',
    size INTEGER DEFAULT 0,
    kind TEXT DEFAULT 'file',           -- image | pdf | doc | text
    text TEXT DEFAULT '',
    pages INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (${NOW})
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    contact_id INTEGER,                 -- who will send it
    text TEXT NOT NULL,
    due_at TEXT NOT NULL,               -- ISO, UTC
    done INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (${NOW})
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(done, due_at);

  -- long-term memory: short facts with embeddings for retrieval
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER,                 -- what this contact remembers (dm)
    chat_id INTEGER,                    -- or shared by a group chat
    text TEXT NOT NULL,
    embedding TEXT DEFAULT '',          -- JSON float array; '' if no embedding model
    source TEXT DEFAULT 'auto',         -- auto | manual
    created_at TEXT DEFAULT (${NOW})
  );
  CREATE INDEX IF NOT EXISTS idx_memories_contact ON memories(contact_id);
  CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id);
`);

function ensureDmChat(contactId) {
  const existing = db.prepare("SELECT id FROM chats WHERE kind = 'dm' AND contact_id = ?").get(contactId);
  if (existing) return existing.id;
  return Number(
    db.prepare("INSERT INTO chats (kind, contact_id) VALUES ('dm', ?)").run(contactId).lastInsertRowid
  );
}

// ---------- Settings ----------

const settingsDefaults = {
  // appearance
  theme: 'default', // default | whatsapp | discord | midnight | paper | sakura | glass | dracula | synthwave
  dark_mode: 'system', // system | light | dark
  accent_color: '', // '' = use the theme's accent
  bubble_style: 'round', // round | flat | classic
  font_size: '14',
  density: 'comfy', // comfy | compact
  wallpaper_url: '',
  wallpaper_dim: '35',
  wallpaper_blur: '0',
  // chat behaviour
  enter_to_send: '1',
  show_timestamps: '1',
  sounds: '1',
  notifications: '1',
  // you
  user_name: '',
  user_about: '',
  user_avatar_url: '',
  // models
  ollama_url: 'http://127.0.0.1:11434',
  default_model: '',
  context_size: '4096',
  single_model: '1', // unload other models before replying (saves RAM on laptops)
  embed_model: 'nomic-embed-text', // for long-term memory retrieval
  global_instructions: '',
  // contacts texting first
  checkins_enabled: '1',
  quiet_start: '23:00',
  quiet_end: '08:00',
  // web
  search_provider: 'duckduckgo', // duckduckgo | searxng
  searxng_url: '',
  read_links: '1',
};
const insSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(settingsDefaults)) insSetting.run(key, value);

module.exports = db;
module.exports.ensureDmChat = ensureDmChat;
module.exports.transaction = transaction;
module.exports.settingsDefaults = settingsDefaults;
