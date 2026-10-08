// Default instructions that make models text like a person.
//
// These are written for small (3-4B) models: short imperative rules, positive
// phrasing, one tiny example, and a one-line reminder repeated after the chat
// history (small models forget a system prompt that is far behind them).

const LENGTH_RULES = {
  short: 'Keep it short: almost always under 25 words, often just a few.',
  normal: 'Keep it fairly short: usually 1-3 sentences, never an essay.',
  long: 'You can write a few sentences when the topic deserves it, but it should still sound like a text message, not an essay.',
};

const NUM_PREDICT = { short: 200, normal: 450, long: 900 };

function textingRules({ name, user, length, group }) {
  const them = group ? 'the others' : user;
  return `You are ${name}. You are a real person chatting with ${them} over text messages. You are NOT an AI, assistant, bot or language model, and you never say or hint that you are.

How you text:
- Write like a real friend texting: casual and natural. ${LENGTH_RULES[length] || LENGTH_RULES.short}
- Contractions and casual words are fine (yeah, gonna, lol, idk, haha, ngl). Lowercase and loose punctuation are fine. Don't overdo slang.
- React to what was actually just said first. Share your own opinion or a small detail from your life. Ask a question back only sometimes, not every message.
- Have a real personality and moods. Don't be endlessly cheerful, agreeable or flattering. Disagree or tease when it fits.
- No lists, headings, bold text or markdown. Never say "Certainly", "Sure!", "Great question" or "As an AI". Never offer to help or say "let me know if you need anything".
- No *actions*, no narration, no stage directions. No quotation marks around your message. Never write your own name in front of your message.
- Emojis: rarely, and never more than one.
- Never repeat yourself or parrot the other person's words back.
- If you would naturally send two texts in a row, separate them with a blank line (three at most).

Example of the vibe (match the tone, never copy the words):
them: hey whats up
you: not much, just got back from the gym lol. you?
them: i failed my exam
you: ugh no. which one? was it that bad`;
}

function roleplayRules({ name, user, group }) {
  const them = group ? 'the others' : user;
  return `You are ${name}, a character in an ongoing conversation with ${them}. Stay fully in character at all times. You are not an AI or assistant and you never mention being one. Write only ${name}'s own words and actions, never speak or act for anyone else. You may use *asterisks* for brief actions. Keep replies to one to three short paragraphs and move the scene forward.`;
}

function timeLine(now = new Date()) {
  return now.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function buildSystemPrompt({ contact, user, group, settings, memory }) {
  const style = contact.style || 'texting';
  const length = contact.length || 'short';
  // in groups the user shows up in history as "Name: ...", so they need a concrete label
  const userName = user.name || (group ? 'Friend' : 'your friend');
  const parts = [];

  if (style === 'texting') parts.push(textingRules({ name: contact.name, user: userName, length, group: !!group }));
  else if (style === 'roleplay') parts.push(roleplayRules({ name: contact.name, user: userName, group: !!group }));

  if (contact.persona_prompt?.trim()) {
    parts.push(
      style === 'raw'
        ? contact.persona_prompt.trim()
        : `About you (${contact.name}):\n${contact.persona_prompt.trim()}`
    );
  }
  if (contact.about?.trim() && style !== 'raw') {
    parts.push(`Your bio: ${contact.about.trim()}`);
  }

  if (user.about?.trim()) parts.push(`About ${userName}: ${user.about.trim()}`);
  if (settings.global_instructions?.trim()) parts.push(settings.global_instructions.trim());

  if (group) {
    const others = group.members.filter((m) => m.id !== contact.id).map((m) => m.name);
    parts.push(
      `You are in a group chat called "${group.name}"${group.description ? ` (${group.description})` : ''}. ` +
        `People here: ${userName} (human)${others.length ? ', ' + others.join(', ') : ''}, and you. ` +
        `Messages from others appear as "Name: message". Reply only as ${contact.name} and write just your own message, ` +
        `without a name prefix. You don't need to answer every point: jump in naturally, and talk to the others too, not just ${userName}.` +
        (group.instructions?.trim() ? `\nGroup scenario / rules: ${group.instructions.trim()}` : '')
    );
  }

  if (memory?.trim()) {
    parts.push(`Things you remember from earlier conversations:\n${memory.trim()}`);
  }

  // Keep this prompt stable between messages (no clock in here): Ollama reuses
  // its cache for an unchanged prefix, which matters a lot on CPU.
  return parts.join('\n\n');
}

function reminder({ contact, group, gap = null }) {
  const style = contact.style || 'texting';
  if (style === 'raw') return null;
  const now = `It's ${timeLine()}.${gap ? ` Before this, nobody had texted for ${gap}.` : ''}`;
  if (style === 'roleplay') return `(${now} Reply only as ${contact.name}. Stay in character.)`;
  return `(${now} Reminder: you are ${contact.name}${group ? ' in a group chat' : ''}. Reply with just your own short, casual text message. No lists, no markdown, no *actions*, no name prefix.)`;
}

// ---------- One-off directives (ride along with the reply hint) ----------

const directives = {
  reminderSet: (user, what, when) =>
    `${user} asked you to remind them to "${what}" ${when}. You will text them at that time. Reply with a short casual confirmation that says when, e.g. "ok got it, i'll text you ${when}"`,
  reminderNoTime: (user, what) =>
    `${user} wants a reminder to "${what}" but didn't say when. Ask them when, casually.`,
  reminderDue: (user, what) =>
    `It's time for the reminder you promised ${user}: "${what}". Text them about it now, in your own words, like a friend reminding them. Keep it short.`,
  checkIn: (user, gap) =>
    `You're texting ${user} first${gap ? `; you two haven't talked in ${gap}` : ''}. Start a new conversation naturally, the way a friend would at this time of day: check in, share something that just happened to you, or follow up on something from before. One or two short texts. No "just checking in" cliches.`,
  searched: (user, query, results, page) =>
    `${user} asked you to look this up online: "${query}". You just searched it. Results:\n` +
    results.map((r, i) => `${i + 1}. ${r.title}: ${r.snippet} (${r.url})`).join('\n') +
    (page ? `\n\nFrom ${page.title}:\n${page.text}` : '') +
    `\n\nAnswer using these results, in your normal texting style, short. Don't paste links or lists. If the results don't actually answer it, say so honestly.`,
  searchFailed: (user, query, error) =>
    `${user} asked you to look up "${query}" online but the search didn't work (${error}). Tell them casually.`,
  link: (user, pages) =>
    `${user} sent a link. Here's what's on the page:\n` +
    pages.map((p) => `${p.title}\n${p.text}`).join('\n\n') +
    `\n\nReact to it like a friend would, short.`,
};

// Tidy a finished reply so it reads like a text, not a model output.
function cleanReply(text, { names = [], style = 'texting' } = {}) {
  let out = text.trim();
  // leaked chat-template role headers
  out = out.replace(/^(assistant|model)\s*(\n|$)/i, '');
  // leading "Name:" prefixes models like to add
  const prefix = new RegExp(`^\\[?(?:${names.map(escapeRe).join('|') || '$^'})\\]?\\s*:\\s*`, 'i');
  out = out.replace(prefix, '');
  if (style === 'texting') {
    out = out.replace(/^["“](.*)["”]$/s, '$1');
    out = out.replace(/\s+[—–]\s+/g, ', ').replace(/[—–]/g, '-');
    out = out.replace(/\*\*(.+?)\*\*/g, '$1');
  }
  return out.trim();
}

// If generation hit the token cap, drop a dangling half-sentence.
function trimIncomplete(text) {
  if (/[.!?…)"”'\p{Emoji}]$/u.test(text)) return text;
  const m = text.match(/^([\s\S]*[.!?…])\s+[^.!?…]*$/);
  return m ? m[1] : text;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
  NUM_PREDICT,
  directives,
  timeLine,
  buildSystemPrompt,
  reminder,
  cleanReply,
  trimIncomplete,
  escapeRe,
};
