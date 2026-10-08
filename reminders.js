// "remind me to call mom at 6" -> { text: 'call mom', due: Date }
// Parsing is deterministic (chrono-node); small models are unreliable at dates.

const chrono = require('chrono-node');

const TRIGGER = /\b(remind me|set (?:a )?reminder|don'?t let me forget|make sure i (?:don'?t forget|remember)|ping me|text me|nudge me)\b/i;

function isReminderRequest(text) {
  return TRIGGER.test(text || '');
}

// Returns null when there's no reminder request, { text, due: null } when the
// time is missing (the contact should ask), or { text, due }.
function parseReminder(message, now = new Date()) {
  if (!isReminderRequest(message)) return null;
  const results = chrono.parse(message, now, { forwardDate: true });
  const hit = results[0];
  let due = null;
  if (hit) {
    due = hit.start.date();
    // "tomorrow" with no time: morning, not chrono's default noon
    if (!hit.start.isCertain('hour')) due.setHours(9, 0, 0, 0);
    // "at 6" when it's 2pm means 6pm today, not 6am tomorrow
    else if (!hit.start.isCertain('meridiem') && hit.start.get('hour') < 12) {
      const pm = new Date(due);
      pm.setHours(hit.start.get('hour') + 12);
      const sameDayPm = new Date(now);
      sameDayPm.setHours(hit.start.get('hour') + 12, hit.start.get('minute') || 0, 0, 0);
      if (sameDayPm > now && !hit.start.isCertain('day')) due = sameDayPm;
    }
    if (due <= now) due = null;
  }

  let what = message;
  if (hit) what = what.replace(hit.text, ' ');
  what = what
    .replace(/^.*?\b(remind me|set (?:a )?reminder|don'?t let me forget|make sure i (?:don'?t forget|remember)|ping me|text me|nudge me)\b/i, '')
    .replace(/^\s*(?:to|about|that|of|for|:)\s+/i, '')
    .replace(/(?:\s+(?:pls|please|plz|ok|okay|thx|thanks|ty|lol|lmao|haha+|hehe|rn|asap|for me))+[\s!.?]*$/i, '')
    .replace(/[\s,.!?]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { text: what || 'the thing you asked about', due };
}

function formatDue(date, now = new Date()) {
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `today at ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} at ${time}`;
}

module.exports = { parseReminder, isReminderRequest, formatDue };
