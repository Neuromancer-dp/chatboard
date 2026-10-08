// fetch wrapper that throws readable errors, plus an NDJSON event reader.

export async function api(path, { method = 'GET', body, form, signal } = {}) {
  const opts = { method, signal };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    let msg = `Request failed (${resp.status})`;
    try {
      const data = await resp.json();
      if (data.error) msg = data.error;
    } catch {}
    throw new Error(msg);
  }
  return resp;
}

export const getJSON = async (path) => (await api(path)).json();
export const sendJSON = async (path, method, body) => {
  const resp = await api(path, { method, body });
  return resp.status === 204 ? null : resp.json();
};

export async function uploadImage(kind, file) {
  const form = new FormData();
  form.append(kind, file);
  return (await api(`/api/upload/${kind}`, { method: 'POST', form })).json();
}

export async function readEvents(resp, onEvent) {
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
      try {
        onEvent(JSON.parse(line));
      } catch (err) {
        console.error('bad event', line, err);
      }
    }
  }
}
