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
const source = readFileSync(require.resolve('../src/content.js'), 'utf8').replace(/  updateMetadata\(\);\n\}\)\(\);\s*$/, '  globalThis.testAPI = { getConversationId, normalizeTimestamp, formatTimestamp, formatModel, readConversation, getAssistantMessages, getBranchTurnNumber, getCommittedFiber, findLiveSnapshot, collectLiveMetadata, updateMetadata, scheduleRender, loadMetadata, observer };\n  updateMetadata();\n})();');

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
    location: { pathname: path },
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

test('renders existing conversation without React internals and is idempotent', async () => {
  const user = message('u', 'user');
  const assistant = message('a');
  const env = setup({ nodes: [user, assistant] });
  assert.equal(badge(assistant).textContent, 'GPT-6 Pro');
  await env.advance(500);
  assert.equal(env.calls.length, 1);
  assert.equal(badge(user), null);
  assert.match(badge(assistant).textContent, /^GPT-5\.6 Thinking · \d{4}-.* · 1$/);
  const writes = badge(assistant).writes;
  env.api.updateMetadata();
  assert.equal(badge(assistant).writes, writes);
  await env.advance(60000);
  assert.equal(env.calls.length, 1);
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

test('retries delayed saves and gives new responses their branch answer number', async () => {
  const first = message('a');
  let saved = false;
  const env = setup({ nodes: [first], fetch: () => response(conversation(apiMessage('a'), ...(saved ? [apiMessage('b')] : []))) });
  await env.advance(500);
  const second = message('b');
  env.root.appendChild(second);
  env.mutate(env.root, 'childList', [second]);
  await env.advance(3000);
  assert.equal(badge(second).textContent, 'GPT-6 Pro');
  saved = true;
  await env.advance(3000);
  assert.match(badge(second).textContent, /Thinking · \d{4}-.* · 2$/);
  assert.equal(env.calls.length, 3);
});

test('authenticated fallback keeps the token out of rendered UI and warnings', async () => {
  const env = setup({
    fetch: (url, options) => {
      if (url === '/api/auth/session') return response({ accessToken: 'test-token' });
      if (!options.headers.Authorization) return response({}, 401);
      return response(conversation(apiMessage('a')));
    },
  });
  await env.advance(500);
  assert.equal(env.calls.length, 3);
  assert.equal(env.calls[2][1].headers.Authorization, 'Bearer test-token');
  assert.match(badge(env.root.firstChild).textContent, /Thinking/);
  assert.equal(env.warnings.length, 0);
  assert.doesNotMatch(env.root.textContent, /test-token/);
});

test('stale A→B→A response cannot overwrite current conversation metadata', async () => {
  let resolveOld;
  const env = setup({
    fetch: () =>
      env.calls.length === 1
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : response(conversation(apiMessage('a', 1790812800, { model_slug: 'current-model' }))),
  });
  await env.advance(500);
  const oldSignal = env.calls[0][1].signal;
  env.context.location.pathname = '/c/B';
  env.api.updateMetadata();
  env.context.location.pathname = '/c/A';
  env.api.updateMetadata();
  assert.equal(oldSignal.aborted, true);
  await env.advance(500);
  resolveOld(response(conversation(apiMessage('a', 1, { model_slug: 'stale-model' }))));
  await env.flush();
  assert.match(badge(env.root.firstChild).textContent, /^current-model/);
});

test('home and share pages do not make conversation requests', async () => {
  for (const path of ['/', '/share/id', '/g/custom', '/?temporary-chat=true']) {
    const env = setup({ path });
    await env.advance(120000);
    assert.equal(env.calls.length, 0);
    assert.equal(badge(env.root.firstChild).textContent, 'GPT-6 Pro');
  }
  const env = setup({ path: '/g/project/c/ABC' });
  await env.advance(500);
  assert.equal(env.calls[0][0], '/backend-api/conversations/ABC?include_has_versions=true&num_turns=100');
});

test('missing or invalid timestamps have bounded retries and never invent dates', async () => {
  const env = setup({ fetch: () => response(conversation(apiMessage('a', null))) });
  await env.advance(120000);
  assert.equal(env.calls.length, 6);
  assert.equal(badge(env.root.firstChild).textContent, 'GPT-5.6 Thinking · 1');
  assert.equal(env.timers.size, 0);
  await env.advance(120000);
  assert.equal(env.calls.length, 6);
});

test('own DOM mutations and unrelated page mutations do not restart exhausted retries', async () => {
  const env = setup({ fetch: () => response(conversation()) });
  await env.advance(120000);
  const count = env.calls.length;
  env.mutate(badge(env.root.firstChild), 'childList', [new Element()]);
  env.mutate(env.root.firstChild, 'childList', [badge(env.root.firstChild)]);
  env.mutate(env.root, 'childList', [new Element()]);
  await env.advance(60000);
  assert.equal(env.calls.length, count);
});

test('a long stream settling can refresh after retries are exhausted', async () => {
  let saved = false;
  const env = setup({ fetch: () => response(conversation(...(saved ? [apiMessage('a')] : []))) });
  await env.advance(120000);
  saved = true;
  env.mutate(env.root.firstChild);
  await env.advance(2000);
  assert.equal(env.calls.length, 7);
  assert.match(badge(env.root.firstChild).textContent, /Thinking · \d{4}-/);
});

test('respects rate limiting and request timeout', async () => {
  const limited = setup({ fetch: () => response({}, 429, { 'Retry-After': '60' }) });
  await limited.advance(60000);
  assert.equal(limited.calls.length, 1);
  await limited.advance(500);
  assert.equal(limited.calls.length, 2);
  const timedOut = setup({ fetch: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Timed out')))) });
  await timedOut.advance(60500);
  assert.equal(timedOut.calls[0][1].signal.aborted, true);
  assert.equal(timedOut.warnings.length, 1);
});

test('reused DOM nodes lose stale time and badges are removed when role changes', async () => {
  const assistant = message('a');
  const env = setup({ nodes: [assistant] });
  await env.advance(500);
  assistant.attributes['data-message-id'] = 'b';
  env.api.updateMetadata();
  assert.equal(badge(assistant).textContent, 'GPT-6 Pro');
  assistant.attributes['data-message-author-role'] = 'user';
  env.api.updateMetadata();
  assert.equal(badge(assistant), null);
});

test('reinjection cleans up old instance and avoids duplicate badges', async () => {
  const env = setup();
  const oldObserver = env.api.observer;
  env.run();
  assert.equal(oldObserver.disconnected, true);
  await env.advance(500);
  assert.equal(env.calls.length, 1);
  assert.equal(env.root.querySelectorAll('.chatgpt-timestamp').length, 1);
});

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

test('recognizes the saved October 2026 HTML with role heading beside the message', async () => {
  const nodes = savedTranscript();
  const env = setup({ nodes, fetch: () => response(conversation(apiMessage('message-2'))) });
  assert.equal(env.root.querySelectorAll('[data-message-id]').length, 0);
  assert.equal(env.root.querySelectorAll('[data-message-author-role]').length, 0);
  const assistants = env.api.getAssistantMessages();
  assert.equal(assistants.length, 1);
  const assistant = assistants[0];
  assert.equal(assistant.element.hasAttribute('data-chatgpt-selection-message-id'), true);
  assert.equal(badge(assistant.element), null);
  assert.equal(env.root.querySelectorAll('.chatgpt-timestamp').length, 0);
  assert.equal(nodes[1].querySelector('[data-conversation-role]').childNodes.length, 0);
  assert.equal(badge(nodes[0]), null);
  await env.advance(500);
  assert.match(badge(assistant.element).textContent, /^GPT-5\.6 Thinking · \d{4}-.* · 1$/);
  assert.equal(env.calls.length, 1);
});

test('search-unit IDs also work without selection attributes or a role heading', async () => {
  const assistant = new Element({
    'data-chatgpt-search-unit-key': 'fallback-turn-0:2:assistant',
    'data-chatgpt-search-message-ids': 'reasoning final final',
  });
  const user = new Element({
    'data-chatgpt-search-unit-key': 'fallback-turn-0:0:user',
    'data-chatgpt-search-message-ids': 'user',
  });
  const env = setup({ nodes: [user, assistant], fetch: () => response(conversation(apiMessage('final'))) });
  assert.equal(env.api.getAssistantMessages().length, 1);
  assert.equal(env.api.getAssistantMessages()[0].id, 'final');
  assert.deepEqual(Array.from(env.api.getAssistantMessages()[0].ids), ['final', 'reasoning']);
  await env.advance(500);
  assert.match(badge(assistant).textContent, /Thinking · \d{4}-/);
  assert.equal(badge(user), null);
});

test('selected final output never borrows the timestamp from a grouped reasoning message', async () => {
  const wrapper = new Element({
    'data-chatgpt-search-unit-key': 'fallback-turn-0:2:assistant',
    'data-chatgpt-search-message-ids': 'reasoning final',
  });
  const assistant = new Element({ 'data-chatgpt-selection-message-id': 'final' });
  wrapper.appendChild(new Element({ 'data-conversation-role': 'assistant' }));
  wrapper.appendChild(assistant);
  const env = setup({ nodes: [wrapper], fetch: () => response(conversation(apiMessage('reasoning'))) });
  await env.advance(500);
  assert.equal(badge(assistant), null);
  await env.advance(120000);
  assert.equal(env.calls.length, 6);
  assert.equal(env.root.querySelectorAll('.chatgpt-timestamp').length, 0);
});

test('new selection IDs are rerendered after branching and retries still follow new transcript text', async () => {
  const nodes = savedTranscript();
  let saved = false;
  const env = setup({ nodes, fetch: () => response(conversation(...(saved ? [apiMessage('branch')] : []))) });
  const element = env.api.getAssistantMessages()[0].element;
  element.attributes['data-chatgpt-selection-message-id'] = 'branch';
  nodes[1].attributes['data-chatgpt-search-message-ids'] = 'branch branch';
  env.mutate(element, 'attributes');
  await env.advance(120000);
  assert.equal(badge(element), null);
  saved = true;
  env.mutate(element);
  await env.advance(2000);
  assert.match(badge(element).textContent, /Thinking · \d{4}-/);
});

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

test('canonical graph supplies answer 30 with only one DOM turn while live snapshot supplies time/model', async () => {
  const live = makeLiveTurn(30);
  const env = setup({ nodes: [live.turn], fetch: () => response({ mapping: live.mapping, current_node: 'a30' }) });
  assert.equal(env.api.getAssistantMessages().length, 1);
  assert.match(badge(live.surface).textContent, /^GPT-6 Pro · \d{4}-/);
  assert.doesNotMatch(badge(live.surface).textContent, / · 30$/);
  await env.advance(120000);
  assert.equal(env.calls.length, 1);
  assert.match(badge(live.surface).textContent, / · 30$/);
  const previous = makeLiveTurn(29);
  env.root.insertBefore(previous.turn, live.turn);
  env.api.updateMetadata();
  assert.match(badge(previous.surface).textContent, / · 29$/);
  assert.match(badge(live.surface).textContent, / · 30$/);
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

test('committed alternate is selected instead of stale React props', async () => {
  const live = makeLiveTurn(7, { model: 'gpt-6-pro' });
  const stale = makeLiveTurn(7, { model: 'stale-model' });
  for (const key of ['root', 'owner', 'component', 'host']) {
    stale[key].alternate = live[key];
    live[key].alternate = stale[key];
  }
  stale.root.stateNode = live.root.stateNode;
  live.turn.__reactFiber$fixture = stale.host;
  const env = setup({ nodes: [live.turn], fetch: () => response({ mapping: live.mapping, current_node: 'a7' }) });
  assert.match(badge(live.surface).textContent, /^GPT-6 Pro ·/);
  await env.advance(500);
  assert.match(badge(live.surface).textContent, / · 7$/);
  assert.doesNotMatch(badge(live.surface).textContent, /stale-model/);
  assert.equal(env.calls.length, 1);
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

test('live metadata refresh replaces model/time and preserves canonical branch number', async () => {
  const live = makeLiveTurn(2);
  const env = setup({ nodes: [live.turn], fetch: () => response({ mapping: live.mapping, current_node: 'a2' }) });
  await env.advance(500);
  live.mapping.a2.message.metadata.resolved_model_slug = 'gpt-5-6-thinking';
  live.mapping.a2.message.create_time = '2026-10-01T00:30:00Z';
  env.api.updateMetadata();
  assert.match(badge(live.surface).textContent, /^GPT-5\.6 Thinking · .* · 2$/);
  assert.equal(badge(live.surface).dataset.signature, JSON.stringify(['a2', 'GPT-5.6 Thinking', 1790814600000, 2]));
});

test('five-turn synthetic render window does not become answer 5 when canonical answer is 30', async () => {
  const live = makeLiveTurn(30);
  const rendered = { root: { id: 'root', parent: null, message: null } };
  for (let i = 26; i <= 30; i++)
    for (const prefix of ['u', 'r', 't', 'a']) {
      const id = `${prefix}${i}`;
      rendered[id] = { ...live.mapping[id] };
    }
  rendered.u26.parent = 'root';
  live.snapshot.renderedConversation.mapping = rendered;
  const env = setup({ nodes: [live.turn], fetch: () => response({ mapping: live.mapping, current_node: 'a30' }) });
  assert.equal(env.api.getBranchTurnNumber(rendered, 'a30'), 5);
  assert.doesNotMatch(badge(live.surface).textContent, / · 5$/);
  await env.advance(500);
  assert.match(badge(live.surface).textContent, / · 30$/);
  const diagnostics = env.context.window[Symbol.for('chatgpt-metadata-extension')].diagnostics();
  assert.equal(diagnostics.largestRenderedNodeCount, 21);
  assert.equal(diagnostics.canonicalNodeCount, 121);
  assert.equal(diagnostics.numberedMessageCount, 60);
  assert.equal(diagnostics.largestCanonicalAnswerNumber, 30);
  env.api.updateMetadata();
  assert.match(badge(live.surface).textContent, / · 30$/);
});

test('unavailable canonical history retains time/model and omits unproven global number', async () => {
  const live = makeLiveTurn(5);
  const env = setup({ nodes: [live.turn], fetch: () => response({}, 503) });
  await env.advance(120000);
  assert.match(badge(live.surface).textContent, /^GPT-6 Pro · \d{4}-/);
  assert.doesNotMatch(badge(live.surface).textContent, / · 5$/);
  assert.equal(env.calls.length, 6);
  const diagnostics = env.context.window[Symbol.for('chatgpt-metadata-extension')].diagnostics();
  assert.equal(diagnostics.canonicalNodeCount, 0);
  assert.equal(diagnostics.lastFetchError, 'Conversation request failed (503)');
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

test('plural messages endpoint loads all older pages and gives global answer 30', async () => {
  const live = makeLiveTurn(30);
  const env = setup({
    nodes: [live.turn],
    fetch: (url) => {
      if (!url.includes('&before=')) return response(historyPage(flatMessages(26, 30), true, 'older/+?&='));
      if (url.endsWith(encodeURIComponent('older/+?&='))) return response(historyPage(flatMessages(11, 26), true, 'oldest'));
      return response(historyPage(flatMessages(1, 11), false));
    },
  });
  await env.advance(500);
  assert.equal(env.calls.length, 3);
  assert.match(env.calls[1][0], /&before=older%2F%2B%3F%26%3D$/);
  assert.match(badge(live.surface).textContent, / · 30$/);
  const diagnostics = env.context.window[Symbol.for('chatgpt-metadata-extension')].diagnostics();
  assert.equal(diagnostics.canonicalNodeCount, 120);
  assert.equal(diagnostics.historyPageCount, 3);
  assert.equal(diagnostics.historySchema, 'messages');
  assert.equal(diagnostics.historyEndpoint, 'conversations');
  assert.equal(diagnostics.historyComplete, true);
  assert.equal(diagnostics.largestCanonicalAnswerNumber, 30);
});

test('flat parent links select the real branch and group reasoning/tool messages', async () => {
  const live = makeLiveTurn(30);
  const messages = flatMessages(1, 30, { parentLinks: true });
  messages.push({ ...apiMessage('side-response'), parent_message_id: 'u20' });
  const env = setup({ nodes: [live.turn], fetch: () => response(historyPage(messages.reverse(), false)) });
  await env.advance(500);
  assert.match(badge(live.surface).textContent, / · 30$/);
  assert.equal(env.context.window[Symbol.for('chatgpt-metadata-extension')].diagnostics().historyComplete, true);
});

test('newest-first pages with missing tool timestamps are assembled in chronological order', async () => {
  const live = makeLiveTurn(30);
  const makePage = (first, last, more) => {
    const messages = flatMessages(first, last);
    messages.forEach((message) => {
      if (message.author.role === 'tool') message.create_time = null;
    });
    return historyPage(messages.reverse(), more, 'earlier');
  };
  const env = setup({ nodes: [live.turn], fetch: (url) => response(url.includes('&before=') ? makePage(1, 25, false) : makePage(26, 30, true)) });
  await env.advance(500);
  assert.equal(env.calls.length, 2);
  assert.match(badge(live.surface).textContent, / · 30$/);
});

test('404 on plural path falls back once to the legacy mapping endpoint', async () => {
  const live = makeLiveTurn(30);
  const env = setup({ nodes: [live.turn], fetch: (url) => (url.includes('/conversations/') ? response({}, 404) : response({ mapping: live.mapping, current_node: 'a30' })) });
  await env.advance(500);
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[1][0], '/backend-api/conversation/A');
  assert.match(badge(live.surface).textContent, / · 30$/);
  assert.equal(env.context.window[Symbol.for('chatgpt-metadata-extension')].diagnostics().historyEndpoint, 'conversation');
});

test('unknown page completeness or newer missing pages never produce a guessed global number', async () => {
  for (const info of [{}, { has_previous_page: false, has_next_page: true }]) {
    const live = makeLiveTurn(30);
    const env = setup({ nodes: [live.turn], fetch: () => response({ ...historyPage(flatMessages(26, 30), false), page_info: info }) });
    await env.advance(500);
    assert.doesNotMatch(badge(live.surface).textContent, / · 5$| · 30$/);
    assert.equal(env.context.window[Symbol.for('chatgpt-metadata-extension')].diagnostics().historyComplete, false);
  }
});

test('repeated cursors stop pagination before publishing partial numbers', async () => {
  const live = makeLiveTurn(30);
  const env = setup({ nodes: [live.turn], fetch: () => response(historyPage(flatMessages(26, 30), true, 'same')) });
  await env.advance(500);
  assert.equal(env.calls.length, 2);
  assert.doesNotMatch(badge(live.surface).textContent, / · 5$/);
  assert.equal(env.context.window[Symbol.for('chatgpt-metadata-extension')].diagnostics().lastFetchError, 'Missing or repeated history cursor');
});

test('pagination rejects conversation/branch changes and cross-page parent conflicts', async () => {
  for (const changed of [{ conversation_id: 'another-conversation' }, { current_node: 'another-head' }, { messages: [{ ...flatMessages(26, 26, { parentLinks: true })[0], parent_message_id: 'different-parent' }] }]) {
    const live = makeLiveTurn(30);
    const env = setup({ nodes: [live.turn], fetch: (url) => response(url.includes('&before=') ? { ...historyPage(flatMessages(1, 26, { parentLinks: true }), false), ...changed } : historyPage(flatMessages(26, 30, { parentLinks: true }), true)) });
    await env.advance(500);
    assert.doesNotMatch(badge(live.surface).textContent, / · 30$/);
    assert.equal(env.context.window[Symbol.for('chatgpt-metadata-extension')].diagnostics().canonicalNodeCount, 0);
    assert.ok(env.warnings.length);
  }
});

test('navigation cancels in-progress pagination without applying its result to a new conversation', async () => {
  const live = makeLiveTurn(30);
  let finishOlder;
  const env = setup({
    nodes: [live.turn],
    fetch: (url) =>
      url.includes('&before=')
        ? new Promise((resolve) => {
            finishOlder = resolve;
          })
        : response(historyPage(flatMessages(26, 30), true)),
  });
  await env.advance(500);
  assert.equal(env.calls.length, 2);
  env.context.location.pathname = '/c/B';
  env.api.updateMetadata();
  assert.equal(env.calls[1][1].signal.aborted, true);
  finishOlder(response(historyPage(flatMessages(1, 25), false)));
  await env.flush();
  assert.equal(env.context.window[Symbol.for('chatgpt-metadata-extension')].diagnostics().canonicalNodeCount, 0);
});
