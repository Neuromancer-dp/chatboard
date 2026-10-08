// Long-term memory: short facts ("Ani has a job interview at Google on Friday")
// stored with embeddings, and the most relevant few recalled for each reply.
// Falls back to keyword overlap when no embedding model is installed.

const db = require('./db');
const { embed, chatOnce } = require('./ollama');

const TOP_K = 4;
const MIN_SCORE = 0.45; // cosine; nomic-embed-text related facts usually score 0.5+
const DUPLICATE_SCORE = 0.9;
const MAX_FACTS_PER_CONTACT = 400;

// nomic-embed-text wants task prefixes; other models ignore them harmlessly
const asDoc = (t) => `search_document: ${t}`;
const asQuery = (t) => `search_query: ${t}`;

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const words = (t) => new Set((t.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []));
function keywordScore(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

const scopeWhere = 'WHERE (contact_id = ? OR (chat_id IS NOT NULL AND chat_id = ?))';

function list({ contactId = null, chatId = null }) {
  return db
    .prepare(`SELECT id, contact_id, chat_id, text, source, created_at, embedding != '' AS embedded FROM memories ${scopeWhere} ORDER BY id DESC`)
    .all(contactId ?? -1, chatId ?? -1);
}

async function add({ contactId = null, chatId = null, texts, source = 'auto', baseUrl, embedModel }) {
  const clean = [...new Set(texts.map((t) => t.trim()).filter((t) => t.length > 3 && t.length < 400))];
  if (!clean.length) return [];
  const vectors = embedModel ? await embed(baseUrl, embedModel, clean.map(asDoc)) : null;
  const existing = db.prepare(`SELECT id, text, embedding FROM memories ${scopeWhere}`).all(contactId ?? -1, chatId ?? -1);
  const ins = db.prepare('INSERT INTO memories (contact_id, chat_id, text, embedding, source) VALUES (?, ?, ?, ?, ?)');
  const added = [];
  clean.forEach((text, i) => {
    const vec = vectors?.[i];
    // skip near-duplicates of something already remembered
    const dup = existing.some((m) => {
      if (vec && m.embedding) return cosine(vec, JSON.parse(m.embedding)) > DUPLICATE_SCORE;
      return m.text.toLowerCase() === text.toLowerCase() || keywordScore(m.text, text) > 0.85;
    });
    if (dup && source === 'auto') return;
    const info = ins.run(contactId, chatId, text, vec ? JSON.stringify(vec) : '', source);
    added.push(Number(info.lastInsertRowid));
    if (vec) existing.push({ text, embedding: JSON.stringify(vec) });
  });
  // keep the table bounded: forget the oldest automatic facts first
  if (contactId) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE contact_id = ?').get(contactId).n;
    if (n > MAX_FACTS_PER_CONTACT) {
      db.prepare(
        `DELETE FROM memories WHERE id IN (SELECT id FROM memories WHERE contact_id = ? AND source = 'auto' ORDER BY id LIMIT ?)`
      ).run(contactId, n - MAX_FACTS_PER_CONTACT);
    }
  }
  return added;
}

// queries: e.g. [latest user message, last few messages]; a fact's score is its best match
async function recall({ contactId, chatId, queries, baseUrl, embedModel }) {
  queries = queries.map((q) => (q || '').trim()).filter(Boolean);
  if (!queries.length) return [];
  const rows = db.prepare(`SELECT id, text, embedding FROM memories ${scopeWhere}`).all(contactId ?? -1, chatId ?? -1);
  if (!rows.length) return [];
  const qvs = embedModel && rows.some((r) => r.embedding) ? await embed(baseUrl, embedModel, queries.map(asQuery)) : null;
  return rows
    .map((r) => {
      const vec = qvs && r.embedding ? JSON.parse(r.embedding) : null;
      const scores = queries.map((q, i) => (vec ? cosine(qvs[i], vec) : keywordScore(q, r.text) * 0.8));
      return { text: r.text, score: Math.max(...scores) };
    })
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)
    .map((r) => r.text);
}

// Ask the contact's own model to pull lasting facts out of a transcript.
async function extractFacts({ transcript, userName, writerName, baseUrl, model, numCtx }) {
  const prompt =
    `${transcript}\n\n` +
    `From the conversation above, list up to 5 facts worth remembering for a long time: things about ${userName} ` +
    `(life, plans, people, likes, problems, feelings), and things ${writerName} promised or shared. ` +
    `Write each as one short standalone sentence using names, not "I" or "you". One per line, starting with "- ". ` +
    `Skip small talk. If there is nothing worth remembering, write NONE.`;
  const out = await chatOnce({
    baseUrl,
    model,
    messages: [{ role: 'user', content: prompt }],
    options: { temperature: 0.2, num_ctx: numCtx },
  });
  if (/^\s*NONE\b/i.test(out)) return [];
  return out
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l && !/^NONE$/i.test(l) && !/^(here are|facts?:)/i.test(l))
    .slice(0, 5);
}

module.exports = { list, add, recall, extractFacts };
