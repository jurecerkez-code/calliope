// Consume a validated edit stream; a missing final event is a failed turn.
export async function consumeApplyStream(response, onEdit) {
  if (!response.ok) {
    const out = await response.json();
    const error = new Error(out.error || 'HTTP ' + response.status);
    error.agentMessage = out.agent_message;
    throw error;
  }
  if (!response.headers.get('content-type')?.startsWith('application/x-ndjson') || !response.body) {
    throw new Error('Agent edit stream unavailable');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', lastHtml = null, done = null;
  function accept(line) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('Invalid agent edit stream'); }
    if (event.type === 'error') throw new Error(event.error || 'Agent edit failed');
    if (event.type === 'edit' && typeof event.html === 'string') {
      if (done) throw new Error('Agent edit after completion');
      lastHtml = event.html;
      onEdit(lastHtml);
    } else if (event.type === 'done' && typeof event.html === 'string' && event.html === lastHtml && !done) {
      done = event;
    } else {
      throw new Error('Invalid agent edit stream');
    }
  }
  try {
    while (true) {
      const {value, done: eof} = await reader.read();
      pending += decoder.decode(value, {stream: !eof});
      if (pending.length > 4_000_000) throw new Error('Agent edit stream too large');
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line) accept(line);
      }
      if (eof) break;
    }
    if (pending || !done) throw new Error('Incomplete agent edit stream');
    return done;
  } finally {
    reader.releaseLock();
  }
}
