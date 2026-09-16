const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'humanchat.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    avatar_url TEXT DEFAULT '',
    model TEXT NOT NULL,
    memory TEXT DEFAULT '',
    persona_prompt TEXT DEFAULT '',
    last_activity_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// migrations for dbs created before these columns existed
const cols = db.prepare("PRAGMA table_info(contacts)").all().map(c => c.name);
if (!cols.includes('last_activity_at')) {
  db.exec("ALTER TABLE contacts ADD COLUMN last_activity_at TEXT DEFAULT (datetime('now'))");
}
if (!cols.includes('persona_prompt')) {
  db.exec("ALTER TABLE contacts ADD COLUMN persona_prompt TEXT DEFAULT ''");
}

const settingsDefaults = {
  theme: 'default', // default | paper | glass
  dark_mode: 'system', // system | light | dark
  wallpaper_url: '',
  ollama_url: 'http://127.0.0.1:11434',
};
const insSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(settingsDefaults)) {
  insSetting.run(key, value);
}

module.exports = db;
