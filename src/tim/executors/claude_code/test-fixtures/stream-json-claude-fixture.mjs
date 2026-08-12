#!/usr/bin/env bun

const sessionId = `fixture-${process.env.TIM_PROCESS_ID ?? process.pid}`;
let inputBuffer = '';
let backgroundPending = false;

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function emitAssistant(text) {
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    session_id: sessionId,
  });
}

function emitResult(text) {
  emit({
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: text,
    session_id: sessionId,
  });
}

function emitBackground(tasks) {
  emit({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks,
    uuid: `${sessionId}-background`,
    session_id: sessionId,
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function handleUserRecord(record) {
  const rawContent = typeof record.message?.content === 'string' ? record.message.content : '';
  const attributedMessage =
    /^Agent message from [a-z0-9-]+(?: \[id: [a-z0-9-]+\])?:\n([\s\S]*)$/.exec(rawContent);
  const content = attributedMessage?.[1] ?? rawContent;
  process.stderr.write(`fixture:${sessionId}:${content}\n`);

  if (content.includes('graceful shutdown')) {
    backgroundPending = false;
    emitBackground([]);
    emitAssistant(`${sessionId}:shutdown`);
    emitResult(`${sessionId}:shutdown`);
    return;
  }

  if (content === 'hold' || content.startsWith('race-hold')) {
    emitAssistant(`${sessionId}:held`);
    return;
  }

  if (content === 'finish-hold') {
    emitAssistant(`${sessionId}:finish-pending`);
    await delay(300);
    emitResult(`${sessionId}:finish-pending`);
    return;
  }

  if (content === 'background-start') {
    backgroundPending = true;
    emitBackground([{ id: `${sessionId}-task` }]);
    emitAssistant(`${sessionId}:background-start`);
    emitResult(`${sessionId}:background-start`);
    return;
  }

  if (content === 'background-invalidate' && backgroundPending) {
    emitAssistant(`${sessionId}:background-invalidated`);
    return;
  }

  if (content === 'background-drain' && backgroundPending) {
    backgroundPending = false;
    emitBackground([]);
    emitResult(`${sessionId}:background-drained`);
    return;
  }

  emitAssistant(`${sessionId}:${content}`);
  emitResult(`${sessionId}:${content}`);

  if (content === 'exit-idle') {
    await delay(50);
    process.exit(0);
  }
}

emit({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  tools: [],
  mcp_servers: [],
});

if (process.argv.includes('--fixture-exit-before-read')) {
  await delay(25);
  process.exit(23);
}

for await (const chunk of process.stdin) {
  inputBuffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
  let newlineIndex = inputBuffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = inputBuffer.slice(0, newlineIndex);
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    newlineIndex = inputBuffer.indexOf('\n');
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type === 'user') {
      await handleUserRecord(record);
    }
  }
}
