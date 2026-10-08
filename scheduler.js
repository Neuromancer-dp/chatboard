// Background jobs, checked every 30s while the server runs:
//  - send reminders that are due
//  - let contacts text first (respecting quiet hours, never double-texting
//    an unanswered check-in)
//  - write memory notes for chats that went quiet

const db = require('./db');
const E = require('./engine');
const Turns = require('./turns');
const P = require('./prompts');

const TICK_MS = 30 * 1000;
const IDLE_SUMMARY_MS = 15 * 60 * 1000;
// hours of silence before a contact texts first: [min, max]
const CHECKIN_HOURS = { sometimes: [5, 12], often: [2, 5] };

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

function minutesOf(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

function inQuietHours(date, settings) {
  const start = minutesOf(settings.quiet_start, 23 * 60);
  const end = minutesOf(settings.quiet_end, 8 * 60);
  if (start === end) return false;
  const m = date.getHours() * 60 + date.getMinutes();
  return start < end ? m >= start && m < end : m >= start || m < end;
}

// Push a time out of quiet hours, to a slightly random moment after they end.
function outOfQuietHours(date, settings) {
  if (!inQuietHours(date, settings)) return date;
  const end = minutesOf(settings.quiet_end, 8 * 60);
  const t = new Date(date);
  t.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (t <= date) t.setDate(t.getDate() + 1);
  return new Date(t.getTime() + rand(5, 75) * 60 * 1000);
}

function humanGap(ms) {
  const h = ms / 36e5;
  if (h < 1) return null;
  if (h < 36) return `about ${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}`;
  return `${Math.round(h / 24)} days`;
}

const lastMessage = (chatId) => db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId);

async function sendDueReminders(settings) {
  const due = db.prepare('SELECT * FROM reminders WHERE done = 0 AND due_at <= ? ORDER BY due_at').all(new Date().toISOString());
  for (const r of due) {
    const chat = E.getChat(r.chat_id);
    const members = chat ? E.chatMembers(chat) : [];
    const sender = members.find((m) => m.id === r.contact_id) || members[0];
    if (!sender) {
      db.prepare('UPDATE reminders SET done = 1 WHERE id = ?').run(r.id);
      continue;
    }
    if (Turns.isBusy(chat.id)) continue; // try again next tick
    db.prepare('UPDATE reminders SET done = 1 WHERE id = ?').run(r.id);
    const lateMin = (Date.now() - new Date(r.due_at)) / 60000;
    const directive =
      P.directives.reminderDue(E.userLabel(settings), r.text) +
      (lateMin > 30 ? ' (You are a bit late with it, the app was closed. Mention that casually.)' : '');
    await Turns.runBackground(chat, [sender], { directive, kind: 'reminder' });
  }
}

async function maybeCheckIn(settings) {
  if (settings.checkins_enabled === '0') return;
  const now = new Date();
  if (inQuietHours(now, settings)) return;

  const chats = db
    .prepare(
      `SELECT ch.*, c.initiative FROM chats ch JOIN contacts c ON c.id = ch.contact_id
       WHERE ch.kind = 'dm' AND c.initiative IN ('sometimes', 'often')`
    )
    .all();
  for (const chat of chats) {
    const lastUser = db.prepare("SELECT MAX(id) AS id FROM messages WHERE chat_id = ? AND role = 'user'").get(chat.id).id;
    if (!lastUser) continue; // never talked yet: don't cold-text
    const lastCheckin = db.prepare("SELECT MAX(id) AS id FROM messages WHERE chat_id = ? AND kind = 'checkin'").get(chat.id).id;
    if (lastCheckin && lastCheckin > lastUser) continue; // their last check-in is still unanswered

    const last = lastMessage(chat.id);
    if (!chat.next_checkin_at) {
      const [lo, hi] = CHECKIN_HOURS[chat.initiative];
      let at = new Date(new Date(last.created_at).getTime() + rand(lo, hi) * 36e5);
      if (at < now) at = new Date(now.getTime() + rand(2, 25) * 60 * 1000); // overdue (app was closed)
      at = outOfQuietHours(at, settings);
      db.prepare('UPDATE chats SET next_checkin_at = ? WHERE id = ?').run(at.toISOString(), chat.id);
      continue;
    }
    if (new Date(chat.next_checkin_at) > now || Turns.isBusy(chat.id)) continue;

    db.prepare('UPDATE chats SET next_checkin_at = NULL WHERE id = ?').run(chat.id);
    const contact = E.getContact(chat.contact_id);
    const directive = P.directives.checkIn(E.userLabel(settings), humanGap(now - new Date(last.created_at)));
    await Turns.runBackground(E.getChat(chat.id), [contact], { directive, kind: 'checkin' });
    return; // at most one per tick
  }
}

const summaryBackoff = new Map(); // chat id -> don't retry before (ms)

async function summarizeIdleChats() {
  const cutoff = new Date(Date.now() - IDLE_SUMMARY_MS).toISOString();
  const candidates = db
    .prepare(
      `SELECT ch.id, ch.summarized_id FROM chats ch
       WHERE (SELECT COUNT(*) FROM messages m WHERE m.chat_id = ch.id AND m.id > ch.summarized_id) >= 4
         AND (SELECT MAX(created_at) FROM messages m WHERE m.chat_id = ch.id) < ?`
    )
    .all(cutoff);
  const chat = candidates.find((c) => !Turns.isBusy(c.id) && (summaryBackoff.get(c.id) || 0) < Date.now());
  if (!chat) return;
  await E.summarizeChat(chat.id);
  // if nothing moved (model offline, nobody left to write it), wait before trying again
  if (E.getChat(chat.id)?.summarized_id === chat.summarized_id) summaryBackoff.set(chat.id, Date.now() + 20 * 60 * 1000);
  else summaryBackoff.delete(chat.id);
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const settings = E.getSettings();
    await sendDueReminders(settings);
    await maybeCheckIn(settings);
    await summarizeIdleChats();
  } catch (err) {
    console.error('scheduler', err);
  } finally {
    running = false;
  }
}

function start() {
  setTimeout(tick, 5000);
  setInterval(tick, TICK_MS);
}

module.exports = { start, inQuietHours };
