// Thin Ollama client: streamed chat as an async generator, plus a filter that
// hides <think>…</think> blocks emitted by reasoning models.

async function* streamChat({ baseUrl, model, messages, options, signal }) {
  const resp = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, think: false, keep_alive: '30m', options }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    let detail = '';
    try {
      detail = (await resp.json()).error || '';
    } catch {}
    const err = new Error(detail || `Ollama error ${resp.status}`);
    err.status = resp.status;
    throw err;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
      if (obj.error) throw new Error(obj.error);
      yield { token: obj.message?.content || '', done: !!obj.done, reason: obj.done_reason };
    }
  }
}

// Model capabilities ("completion", "vision", "thinking", ...) from /api/show, cached.
const capsCache = new Map();
async function modelCapabilities(baseUrl, model) {
  const key = `${baseUrl}|${model}`;
  if (capsCache.has(key)) return capsCache.get(key);
  try {
    const resp = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return [];
    const caps = (await resp.json()).capabilities || [];
    capsCache.set(key, caps);
    return caps;
  } catch {
    return [];
  }
}

// unknown (older Ollama without capabilities) counts as "maybe"
const canSee = (caps) => (caps.length ? caps.includes('vision') : true);

const withTag = (name) => (/:[^/]+$/.test(name) ? name : `${name}:latest`);

// Free RAM: unload every model Ollama has in memory except the ones about to be used.
async function unloadOthers(baseUrl, keep) {
  const keepTags = [keep].flat().filter(Boolean).map(withTag);
  try {
    const resp = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(3000) });
    const { models = [] } = await resp.json();
    const others = models.map((m) => m.name || m.model).filter((n) => !keepTags.includes(withTag(n)));
    await Promise.all(
      others.map((model) =>
        fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, keep_alive: 0 }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => {})
      )
    );
  } catch {}
}

// Vectors for long-term memory. Returns null if the embedding model isn't available.
async function embed(baseUrl, model, inputs) {
  try {
    const resp = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: inputs, keep_alive: '10m' }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return null;
    const { embeddings } = await resp.json();
    return Array.isArray(embeddings) && embeddings.length === inputs.length ? embeddings : null;
  } catch {
    return null;
  }
}

async function chatOnce({ baseUrl, model, messages, options }) {
  let text = '';
  for await (const part of streamChat({ baseUrl, model, messages, options })) text += part.token;
  // drop markdown title lines small models like to put on top
  return stripThinking(text)
    .replace(/^\s*(\*\*[^*\n]+\*\*|#+ .*)\s*$/gm, '')
    .trim();
}

function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
}

function partialSuffix(str, tag) {
  for (let k = Math.min(tag.length - 1, str.length); k > 0; k--) {
    if (str.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

class ThinkFilter {
  constructor() {
    this.buf = '';
    this.inside = false;
  }

  push(chunk) {
    this.buf += chunk;
    let out = '';
    while (true) {
      const tag = this.inside ? '</think>' : '<think>';
      const i = this.buf.indexOf(tag);
      if (i >= 0) {
        if (!this.inside) out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + tag.length);
        this.inside = !this.inside;
        continue;
      }
      const keep = partialSuffix(this.buf, tag);
      const settled = this.buf.slice(0, this.buf.length - keep);
      if (!this.inside) out += settled;
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  flush() {
    const out = this.inside ? '' : this.buf;
    this.buf = '';
    return out;
  }
}

module.exports = { streamChat, chatOnce, embed, unloadOthers, modelCapabilities, canSee, ThinkFilter, stripThinking };
