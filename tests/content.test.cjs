const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

// A small in-memory DOM and clock: these tests never open a browser or use the network.
class Element {
  constructor(attributes = {}) {
    this.nodeType = 1;
    this.attributes = { ...attributes };
    this.childNodes = [];
    this.parentElement = null;
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.text = '';
    this.writes = 0;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get textContent() {
    return this.text + this.childNodes.map((node) => node.textContent).join('');
  }
  set textContent(value) {
    this.text = value;
    this.replaceChildren();
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name) {
    return Object.hasOwn(this.attributes, name);
  }
  matches(selector) {
    return selector.split(',').some((item) => {
      item = item.trim();
      if (item.startsWith('.')) return this.className.split(' ').includes(item.slice(1));
      const match = item.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (!match) throw new Error(`Unsupported test selector: ${item}`);
      return this.hasAttribute(match[1]) && (match[2] === undefined || this.getAttribute(match[1]) === match[2]);
    });
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    if (selector.startsWith(':scope > ')) return this.childNodes.filter((node) => node.matches(selector.slice(9)));
    return this.childNodes.flatMap((node) => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  appendChild(node) {
    return this.insertBefore(node, null);
  }
  insertBefore(node, before) {
    node.remove();
    node.parentElement = this;
    this.childNodes.splice(before ? this.childNodes.indexOf(before) : this.childNodes.length, 0, node);
    this.writes++;
    return node;
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  replaceChildren() {
    this.childNodes.forEach((node) => {
      node.parentElement = null;
    });
    this.childNodes = [];
    this.writes++;
  }
}

const message = (id, role = 'assistant', model = 'gpt-6-pro') =>
  new Element({
    'data-message-id': id,
    'data-message-author-role': role,
    'data-message-model-slug': model,
  });
const conversation = (...messages) => {
  const mapping = { root: { id: 'root', parent: null, message: null } };
  let parent = 'root';
  for (const message of messages) {
    if (message.author?.role === 'assistant') {
      const id = `user-for-${message.id}`;
      mapping[id] = { id, parent, message: { id, author: { role: 'user' } } };
      parent = id;
    }
    mapping[message.id] = { id: message.id, parent, message };
    parent = message.id;
  }
  return { mapping, current_node: parent };
};
const apiMessage = (id, create_time = 1790812800, metadata = { model_slug: 'gpt-5-6-thinking' }) => ({ id, create_time, metadata, author: { role: 'assistant' } });
const response = (data, status = 200, headers) => new Response(JSON.stringify(data), { status, headers });
const source = readFileSync(require.resolve('../src/content.js'), 'utf8').replace(/  updateMetadata\(\);\n\}\)\(\);\s*$/, '  globalThis.testAPI = { getConversationId, normalizeTimestamp, formatTimestamp, formatModel, readConversation, getAssistantMessages, getBranchTurnNumber, getCommittedFiber, findLiveSnapshot, collectLiveMetadata, updateMetadata, scheduleRender, loadMetadata, fetchConversation, readFlatHistory, readFlatMessage, projectHistory, requestConversationJson, observer };\n  updateMetadata();\n})();');

function setup({ path = '/c/A', nodes = [message('a')], fetch = () => response(conversation(apiMessage('a'))) } = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const calls = [];
  const warnings = [];
  const root = new Element();
  nodes.forEach((node) => root.appendChild(node));
  const listeners = new Map();
  const window = {
    fetch: async (...args) => {
      calls.push(args);
      return fetch(...args);
    },
    setTimeout(fn, delay) {
      const id = ++timerId;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {
      return ++timerId;
    },
    clearInterval() {},
    addEventListener(name, fn) {
      listeners.set(name, fn);
    },
    removeEventListener(name) {
      listeners.delete(name);
    },
  };
  const document = {
    documentElement: root,
    visibilityState: 'visible',
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    createElement: () => new Element(),
    addEventListener: window.addEventListener,
    removeEventListener: window.removeEventListener,
  };
  const context = vm.createContext({
    window,
    document,
    location: { pathname: path, origin: 'https://chatgpt.com', href: 'https://chatgpt.com' + path },
    URL,
    Request,
    AbortController,
    console: { warn: (...args) => warnings.push(args) },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
  });
  const run = () => vm.runInContext(source, context);
  run();
  const flush = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };
  const advance = async (milliseconds) => {
    const end = now + milliseconds;
    for (;;) {
      await flush();
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    now = end;
    await flush();
  };
  const mutate = (target, type = 'characterData', addedNodes = [], removedNodes = []) => context.testAPI.observer.callback([{ target, type, addedNodes, removedNodes }]);
  return { context, api: context.testAPI, root, calls, warnings, timers, advance, flush, mutate, run, listeners };
}

const badge = (node) => node.querySelector(':scope > .chatgpt-timestamp');

function savedTranscript() {
  const fixture = require('./fixtures/chatgpt-transcript.json');
  const fromNode = (node) => {
    const element = new Element(node.attrs);
    element.tagName = node.tag.toUpperCase();
    element.className = node.attrs.class ?? '';
    node.children.forEach((child) => element.appendChild(fromNode(child)));
    return element;
  };
  return fixture.nodes.map(fromNode);
}

function makeLiveTurn(number = 30, { finalTime = 1790812800, model = 'gpt-6-pro' } = {}) {
  const mapping = { root: { id: 'root', parent: null, message: null } };
  let parent = 'root';
  for (let i = 1; i <= number; i++) {
    const user = `u${i}`;
    mapping[user] = { id: user, parent, message: { id: user, author: { role: 'user' } } };
    const reasoning = `r${i}`;
    mapping[reasoning] = { id: reasoning, parent: user, message: apiMessage(reasoning, 1790812700, { model_slug: 'reasoning-model' }) };
    const tool = `t${i}`;
    mapping[tool] = { id: tool, parent: reasoning, message: { id: tool, author: { role: 'tool' } } };
    const final = `a${i}`;
    mapping[final] = { id: final, parent: tool, message: apiMessage(final, finalTime, { resolved_model_slug: model, model_slug: 'default-model' }) };
    parent = final;
  }
  const units = savedTranscript();
  const turn = new Element({ 'data-turn-key': `u${number}` });
  units[0].attributes['data-chatgpt-search-message-ids'] = `u${number}`;
  units[1].attributes['data-chatgpt-search-message-ids'] = `r${number} a${number}`;
  const surface = units[1].querySelector('[data-chatgpt-selection-message-id]');
  surface.attributes['data-chatgpt-selection-message-id'] = `a${number}`;
  surface.attributes['data-chatgpt-selection-conversation-id'] = 'A';
  units.forEach((unit) => turn.appendChild(unit));
  const items = [
    { type: 'user-message', messageId: `u${number}` },
    { type: 'assistant-message', phase: 'analysis', messageId: `r${number}` },
    { type: 'assistant-message', phase: 'final_answer', messageId: `a${number}`, latestMessageId: `a${number}` },
  ];
  const entry = { id: `u${number}`, conversationId: 'A', turn: { items } };
  const snapshot = { renderedConversation: { mapping, current_node: parent }, renderedTurns: [entry] };
  const host = { memoizedProps: {}, return: null };
  const component = { memoizedProps: { entry }, return: null, child: host };
  const owner = { memoizedProps: { conversationId: 'A' }, memoizedState: { memoizedState: snapshot, next: null }, child: component, return: null };
  const root = { tag: 3, child: owner, return: null, stateNode: null };
  root.stateNode = { current: root };
  owner.return = root;
  component.return = owner;
  host.return = component;
  turn.__reactFiber$fixture = host;
  return { turn, surface, mapping, entry, snapshot, host, component, owner, root };
}

function flatMessages(first, last, { parentLinks = false } = {}) {
  const messages = [];
  for (let i = first; i <= last; i++) {
    const user = { id: `u${i}`, author: { role: 'user' }, create_time: 1790810000 + i * 100 };
    const reasoning = apiMessage(`r${i}`, 1790810010 + i * 100);
    const tool = { id: `t${i}`, author: { role: 'tool' }, create_time: 1790810020 + i * 100 };
    const final = apiMessage(`a${i}`, 1790810030 + i * 100, { resolved_model_slug: 'gpt-6-pro' });
    if (parentLinks) {
      user.parent_message_id = i === 1 ? null : `a${i - 1}`;
      reasoning.parent_message_id = user.id;
      tool.parent_message_id = reasoning.id;
      final.parent_message_id = tool.id;
    }
    messages.push(user, reasoning, tool, final);
  }
  return messages;
}

const historyPage = (messages, more, cursor = 'cursor', currentNode = 'a30') => ({
  conversation_id: 'A',
  current_node: currentNode,
  messages,
  page_info: { start_cursor: cursor, end_cursor: 'end', has_previous_page: more, has_next_page: false },
});

test('normalizes real timestamps and preserves unknown model names', () => {
  const { api } = setup({ nodes: [] });
  for (const value of [null, undefined, '', 'garbage', 0, -1, NaN, Infinity, 1e20]) assert.equal(api.normalizeTimestamp(value), null);
  assert.equal(api.normalizeTimestamp(1790812800), 1790812800000);
  assert.equal(api.normalizeTimestamp('1790812800'), 1790812800000);
  assert.equal(api.normalizeTimestamp('2026-10-01T00:00:00Z'), 1790812800000);
  assert.equal(api.normalizeTimestamp(1790812800000), 1790812800000);
  assert.equal(api.formatModel('gpt-5-6-thinking'), 'GPT-5.6 Thinking');
  assert.equal(api.formatModel('gpt-5-4-auto-thinking'), 'GPT-5.4 Thinking');
  assert.equal(api.formatModel('gpt-5.4-auto-thinking'), 'GPT-5.4 Thinking');
  assert.equal(api.formatModel('GPT-5-4-AUTO-THINKING'), 'GPT-5.4 Thinking');
  assert.equal(api.formatModel('gpt-5-4-auto-instant'), 'GPT-5.4 Instant');
  assert.equal(api.formatModel('gpt-5-4-auto'), 'GPT-5.4 Auto');
  assert.equal(api.formatModel('gpt-5-4-auto-experimental'), 'GPT-5.4-auto-experimental');
  assert.equal(api.formatModel('gpt-6-pro'), 'GPT-6 Pro');
  assert.equal(api.formatModel('gpt-4o-mini'), 'GPT-4o Mini');
  assert.equal(api.formatModel('new_model_v2'), 'new_model_v2');
  assert.equal(api.formatModel('  '), null);
  assert.match(api.formatTimestamp(1790812800000), /^\d{4}-\d{2}-\d{2} \w{3} \d{2}:\d{2}$/);
});

test('maps all assistant branches by ID and prefers resolved model metadata', () => {
  const { api } = setup({ nodes: [] });
  const data = api.readConversation(conversation(apiMessage('a', 1790812800, { resolved_model_slug: 'actual', server_ste_metadata: { model_slug: 'routed' }, model_slug: 'default' }), apiMessage('b', null, { server_ste_metadata: { model_slug: 'routed' } }), { id: 'user', author: { role: 'user' }, create_time: 1790812800 }));
  assert.equal(data.size, 2);
  assert.equal(data.get('a').model, 'actual');
  assert.equal(data.get('b').model, 'routed');
  assert.equal(data.get('b').timestamp, null);
  assert.throws(() => api.readConversation({ error: 'denied' }), /Unsupported/);
});

test('handles nested role attributes, non-div messages, hidden branches and duplicate IDs', () => {
  const wrapper = new Element({ 'data-message-author-role': 'assistant' });
  const inner = new Element({ 'data-message-id': 'nested' });
  wrapper.appendChild(inner);
  const outer = new Element({ 'data-message-id': 'outer' });
  outer.appendChild(new Element({ 'data-message-author-role': 'assistant' }));
  const hidden = message('hidden');
  hidden.attributes.hidden = '';
  const env = setup({ nodes: [wrapper, outer, hidden, message('nested')] });
  assert.deepEqual(
    Array.from(env.api.getAssistantMessages(), ({ id }) => id),
    ['nested', 'outer'],
  );
  assert.equal(badge(inner), null);
  assert.equal(badge(outer), null);
});

test('branch numbering groups reasoning/tools/final output and rejects incomplete or cyclic ancestry', () => {
  const { api } = setup({ nodes: [] });
  const { mapping } = makeLiveTurn(30);
  assert.equal(api.getBranchTurnNumber(mapping, 'a30'), 30);
  assert.equal(api.getBranchTurnNumber(mapping, 'r30'), 30);
  const regenerated = 'a30-alternative';
  mapping[regenerated] = { id: regenerated, parent: 't30', message: apiMessage(regenerated) };
  assert.equal(api.getBranchTurnNumber(mapping, regenerated), 30);
  mapping.a30.parent = 'missing';
  assert.equal(api.getBranchTurnNumber(mapping, 'a30'), null);
  mapping.a30.parent = 'a30';
  assert.equal(api.getBranchTurnNumber(mapping, 'a30'), null);
  mapping.a30.parent = undefined;
  assert.equal(api.getBranchTurnNumber(mapping, 'a30'), null);
});

test('snapshot from another conversation and ambiguous live mappings are rejected', () => {
  const wrong = makeLiveTurn();
  wrong.entry.conversationId = 'another-conversation';
  const envWrong = setup({ nodes: [wrong.turn] });
  assert.equal(badge(wrong.surface), null);
  assert.equal(envWrong.api.collectLiveMetadata(envWrong.api.getAssistantMessages()).size, 0);
  const ambiguous = makeLiveTurn();
  ambiguous.owner.memoizedState.next = {
    memoizedState: { renderedConversation: { mapping: { ...ambiguous.mapping } }, renderedTurns: [ambiguous.entry] },
    next: null,
  };
  const env = setup({ nodes: [ambiguous.turn] });
  assert.equal(badge(ambiguous.surface), null);
  assert.equal(env.api.collectLiveMetadata(env.api.getAssistantMessages()).size, 0);
});

test('snapshot in compiler memo cache is found, and cyclic or uncommitted Fiber paths fail closed', () => {
  const live = makeLiveTurn(3);
  live.owner.memoizedState = null;
  live.owner.updateQueue = { memoCache: { data: [[live.snapshot]] } };
  const env = setup({ nodes: [live.turn] });
  assert.match(badge(live.surface).textContent, /^GPT-6 Pro · \d{4}-/);
  assert.equal(env.api.collectLiveMetadata(env.api.getAssistantMessages()).size, 1);
  live.host.return = live.host;
  assert.equal(env.api.getCommittedFiber(live.turn), null);
  const uncommitted = makeLiveTurn();
  uncommitted.root.stateNode.current = {};
  assert.equal(env.api.getCommittedFiber(uncommitted.turn), null);
});

test('live final answer never displays an earlier reasoning timestamp when final time is absent', () => {
  const live = makeLiveTurn(4, { finalTime: null });
  setup({ nodes: [live.turn] });
  assert.equal(badge(live.surface).textContent, 'GPT-6 Pro');
  assert.doesNotMatch(badge(live.surface).textContent, /reasoning-model|2026-/);
});

test('explicitly paginated response and detached user root do not supply global answer numbers', () => {
  const { api } = setup({ nodes: [] });
  const data = conversation(apiMessage('a'));
  assert.equal(api.readConversation({ ...data, has_more: true }).get('a').turnNumber, null);
  assert.equal(api.readConversation({ ...data, is_partial: true }).get('a').turnNumber, null);
  assert.equal(api.readConversation({ mapping: data.mapping }).get('a').turnNumber, null);
  data.mapping['user-for-a'].parent = null;
  assert.equal(api.readConversation(data).get('a').turnNumber, null);
});

const diagnostics = (env) => env.context.window[Symbol.for('chatgpt-metadata-extension')].diagnostics();
const observe = async (env, url = '/backend-api/conversations/A?num_turns=10&include_has_versions=true', init = {}) => {
  const response = await env.context.window.fetch(url, init);
  // Response.clone() uses asynchronous streams in Node, independently of our fake clock.
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
  await env.flush();
  return response;
};

test('does not issue independent requests or poll when page history is unavailable', async () => {
  const env = setup();
  await env.advance(120000);
  assert.equal(env.calls.length, 0);
  assert.equal(diagnostics(env).observedResponses, 0);
  assert.equal(badge(env.root.firstChild).textContent, 'GPT-6 Pro');
});

test('observes real flat schema without consuming the host response or reading credentials', async () => {
  const env = setup({ fetch: () => response(historyPage(flatMessages(1, 1), false, 'first', 'a1')), nodes: [message('a1')] });
  const init = {
    headers: new Proxy(
      {},
      {
        get() {
          throw new Error('must not inspect headers');
        },
      },
    ),
  };
  const host = await observe(env, undefined, init);
  assert.equal((await host.json()).messages.length, 4);
  assert.equal(env.calls.length, 1);
  assert.match(badge(env.root.firstChild).textContent, / · 1$/);
  assert.equal(diagnostics(env).historyComplete, true);
});

test('partial initial window backfills with opaque app context and cursor pagination', async () => {
  const live = makeLiveTurn(30);
  const context = { appContext: 'opaque' };
  const env = setup({ nodes: [live.turn], fetch: (url) => response(url.includes('num_turns=10&') ? historyPage(flatMessages(26, 30), true, 'latest') : url.includes('&before=') ? historyPage(flatMessages(1, 25), false) : historyPage(flatMessages(26, 30), true, 'older/+?&=')) });
  await observe(env, undefined, context);
  assert.equal(env.calls.length, 3);
  assert.match(env.calls[2][0], /&before=older%2F%2B%3F%26%3D$/);
  assert.equal(env.calls[1][1].appContext, 'opaque');
  assert.match(badge(live.surface).textContent, / · 30$/);
  assert.equal(diagnostics(env).historyPageCount, 2);
  env.api.updateMetadata();
  assert.equal(diagnostics(env).committedTurnCount, 0);
});

test('404 is observed without session-token reads or singular-endpoint retry storm', async () => {
  const env = setup({ fetch: () => response({}, 404) });
  await observe(env);
  for (let i = 0; i < 20; i++) env.api.updateMetadata();
  await env.advance(120000);
  assert.equal(env.calls.length, 1);
  assert.equal(diagnostics(env).canonicalNodeCount, 0);
});

test('flat path order wins over timestamp skew, duplicate times and metadata parent_id', () => {
  const { api } = setup({ nodes: [] });
  const rows = flatMessages(1, 3);
  rows.forEach((m, i) => {
    m.create_time = 1000 - i;
    m.metadata = { ...m.metadata, parent_id: 'not-a-graph-parent' };
  });
  const records = rows.map(api.readFlatMessage);
  const result = api.readFlatHistory(records, 'a3', true);
  assert.equal(result.messages.get('a3').turnNumber, 3);
  assert.equal(result.userTurns.get('u3'), 3);
  assert.equal(Object.hasOwn(records[0], 'content'), false);
  assert.equal(Object.hasOwn(records[0], 'metadata'), false);
});

test('unknown completeness and repeated cursors never publish a local window as global', async () => {
  for (const more of [undefined, true]) {
    const env = setup({ nodes: [message('a30')], fetch: () => response(historyPage(flatMessages(26, 30), more, 'same')) });
    await observe(env);
    assert.doesNotMatch(badge(env.root.firstChild).textContent, / · 5$| · 30$/);
    assert.equal(diagnostics(env).historyComplete === true, false);
    if (more) assert.match(diagnostics(env).lastFetchError, /repeated/);
  }
});

test('proven numbers survive partial responses, DOM unmount/remount and missing time/model', async () => {
  let partial = false;
  const env = setup({ nodes: [message('a3')], fetch: () => response(partial ? { ...historyPage(flatMessages(3, 3), false, 'last', 'a3'), page_info: {} } : historyPage(flatMessages(1, 3), false, 'start', 'a3')) });
  await observe(env);
  env.root.firstChild.remove();
  env.api.updateMetadata();
  const remounted = message('a3');
  env.root.appendChild(remounted);
  env.api.updateMetadata();
  assert.match(badge(remounted).textContent, / · 3$/);
  partial = true;
  await observe(env);
  assert.match(badge(remounted).textContent, / · 3$/);
  assert.equal(env.calls.length, 2);
});

test('reasoning, tool calls, UI components and a regenerated answer stay in one answer group', () => {
  const { api } = setup({ nodes: [] });
  const rows = flatMessages(1, 2);
  rows.splice(3, 0, { id: 'component', author: { role: 'assistant' }, channel: 'commentary', metadata: { is_visually_hidden_from_conversation: true } });
  const result = api.readFlatHistory(rows.map(api.readFlatMessage), 'a2', true);
  assert.equal(result.messages.get('r2').turnNumber, 2);
  assert.equal(result.messages.get('a2').turnNumber, 2);
  assert.equal(result.messages.get('component').turnNumber, null);
  const branch = flatMessages(1, 2);
  branch.at(-1).id = 'regenerated';
  assert.equal(api.readFlatHistory(branch.map(api.readFlatMessage), 'regenerated', true).messages.get('regenerated').turnNumber, 2);
});

test('new live answer anchors to canonical ancestry and survives render-window remount', async () => {
  const live = makeLiveTurn(3);
  const env = setup({ nodes: [live.turn], fetch: () => response(historyPage(flatMessages(1, 2), false, 'first', 'a2')) });
  await observe(env);
  assert.match(badge(live.surface).textContent, / · 3$/);
  assert.equal(diagnostics(env).largestCanonicalAnswerNumber, 2);
  const newer = makeLiveTurn(3);
  live.turn.remove();
  env.root.appendChild(newer.turn);
  env.api.updateMetadata();
  assert.match(badge(newer.surface).textContent, / · 3$/);
  assert.equal(env.calls.length, 1);
});

test('synthetic roots without known ancestors cannot provide global numbering', async () => {
  const live = makeLiveTurn(30);
  const rendered = { root: live.mapping.root };
  for (const prefix of ['u', 'r', 't', 'a']) rendered[prefix + '30'] = { ...live.mapping[prefix + '30'] };
  rendered.u30.parent = 'root';
  live.snapshot.renderedConversation.mapping = rendered;
  const env = setup({ nodes: [live.turn] });
  assert.doesNotMatch(badge(live.surface).textContent, / · 1$| · 30$/);
  assert.equal(diagnostics(env).canonicalNodeCount, 0);
});

test('navigation aborts backfill and late A→B→A results are rejected', async () => {
  let finish;
  const env = setup({
    nodes: [message('a30')],
    fetch: (url) =>
      url.includes('num_turns=100')
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : response(historyPage(flatMessages(26, 30), true)),
  });
  await observe(env);
  const signal = env.calls[1][1].signal;
  env.context.location.pathname = '/c/B';
  env.api.updateMetadata();
  env.context.location.pathname = '/c/A';
  env.api.updateMetadata();
  assert.equal(signal.aborted, true);
  finish(response(historyPage(flatMessages(1, 30), false)));
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
  assert.equal(diagnostics(env).canonicalNodeCount, 0);
});

test('opaque Request inputs preserve context and override the app abort signal', async () => {
  let n = 0;
  const env = setup({ nodes: [message('a1')], fetch: () => response(historyPage(flatMessages(1, 1), n++ === 0, 'first', 'a1')) });
  const controller = new AbortController();
  const input = new Request('https://chatgpt.com/backend-api/conversations/A?num_turns=10', { signal: controller.signal, credentials: 'same-origin' });
  await observe(env, input);
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[0][0], input);
  const backfill = env.calls[1][0];
  assert.ok(backfill instanceof Request);
  assert.match(backfill.url, /num_turns=100/);
  assert.equal(backfill.credentials, 'same-origin');
  controller.abort();
  assert.equal(backfill.signal.aborted, false);
  assert.match(badge(env.root.firstChild).textContent, / · 1$/);
});

test('reinjection restores fetch wrappers and avoids duplicate badges', async () => {
  const env = setup();
  const original = env.context.window.fetch;
  const old = env.api.observer;
  env.run();
  assert.equal(old.disconnected, true);
  assert.notEqual(env.context.window.fetch, original);
  assert.equal(env.root.querySelectorAll('.chatgpt-timestamp').length, 1);
});

test('metadata projection drops bodies, author details, attachments and unrelated fields', () => {
  const { api } = setup({ nodes: [] });
  const projected = api.projectHistory({ ...historyPage([{ ...apiMessage('a'), content: { parts: ['private-text'] }, author: { role: 'assistant', name: 'private-name' }, metadata: { model_slug: 'gpt-6', private: 'private-value' } }], false, 'first', 'a'), title: 'private-title', owner: 'private-owner' });
  assert.doesNotMatch(JSON.stringify(projected), /private-/);
  assert.equal(projected.messages[0].metadata.resolved_model_slug, 'gpt-6');
});

test('transient backfill failures retry within one job, then recover', async () => {
  const env = setup({ nodes: [] });
  let calls = 0;
  const pending = env.api.requestConversationJson('/metadata', new AbortController().signal, async () => (++calls < 3 ? response({}, 503) : response(historyPage(flatMessages(1, 1), false, 'start', 'a1'))));
  await env.flush();
  await env.advance(4500);
  assert.equal((await pending).current_node, 'a1');
  assert.equal(calls, 3);
});

test('rate limit delay respects Retry-After and navigation cancels retry waits', async () => {
  const env = setup({ nodes: [] });
  const controller = new AbortController();
  let calls = 0;
  const pending = env.api.requestConversationJson('/metadata', controller.signal, async () => {
    calls++;
    return response({}, 429, { 'Retry-After': '45' });
  });
  const rejected = assert.rejects(pending, /aborted/);
  await env.flush();
  await env.advance(44000);
  assert.equal(calls, 1);
  controller.abort();
  await rejected;
  await env.advance(60000);
  assert.equal(calls, 1);
});

test('branch-linked flat records choose ancestry rather than unrelated alternate responses', () => {
  const { api } = setup({ nodes: [] });
  const rows = flatMessages(1, 3, { parentLinks: true });
  rows.push({ ...apiMessage('alternate'), parent_message_id: 'u2' });
  const result = api.readFlatHistory(rows.reverse().map(api.readFlatMessage), 'a3', true);
  assert.equal(result.messages.get('a3').turnNumber, 3);
  assert.equal(result.messages.get('alternate').turnNumber, null);
});

test('a floating conversation panel cannot donate messages to the current conversation', () => {
  const surface = new Element({ 'data-chatgpt-selection-message-id': 'other', 'data-chatgpt-selection-conversation-id': 'B', 'data-conversation-role': 'assistant' });
  const env = setup({ nodes: [message('current'), surface] });
  assert.deepEqual(
    Array.from(env.api.getAssistantMessages(), (x) => x.id),
    ['current'],
  );
  assert.equal(badge(surface), null);
});

test('same-head observations refresh final time/model without refetching history', async () => {
  let model = 'first-model';
  const env = setup({
    nodes: [message('a1')],
    fetch: () => {
      const rows = flatMessages(1, 1);
      rows.at(-1).metadata.resolved_model_slug = model;
      return response(historyPage(rows, false, 'start', 'a1'));
    },
  });
  await observe(env);
  model = 'resolved-model';
  await observe(env);
  await env.advance(100);
  assert.match(badge(env.root.firstChild).textContent, /^resolved-model .* · 1$/);
  assert.equal(env.calls.length, 2);
});
