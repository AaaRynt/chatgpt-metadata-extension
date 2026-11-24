// Forked from https://github.com/Hangzhi/chatgpt-timestamp-extension
(() => {
  'use strict';

  const INSTANCE_KEY = Symbol.for('chatgpt-metadata-extension');
  window[INSTANCE_KEY]?.();

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const METADATA_CLASS = 'chatgpt-timestamp';
  const MESSAGE_SELECTOR = '[data-message-id], [data-chatgpt-selection-message-id], [data-chatgpt-search-message-ids]';
  const ROLE_SELECTOR = '[data-message-author-role], [data-conversation-role]';
  const SELECTION_SELECTOR = '[data-chatgpt-selection-message-id]';
  const SEARCH_SELECTOR = '[data-chatgpt-search-message-ids]';
  const COLORS = { model: '#98c379', timestamp: '#56b6c2', turnNumber: '#e06c75' };
  const REQUEST_TIMEOUT = 60000;
  const MAX_HISTORY_PAGES = 100;
  const MAX_HISTORY_MESSAGES = 50000;
  const originalFetch = window.fetch;
  const fetch = originalFetch.bind(window);

  let conversationId = null;
  let metadataById = new Map();
  let request = null;
  let routeEpoch = 0;
  let renderTimer;
  let userTurns = new Map();
  let observedResponses = 0;
  const conversationCaches = new Map();
  let disposed = false;
  let liveDiagnostics = {};
  let lastFetchError = null;
  let historyDiagnostics = { canonicalNodeCount: 0, numberedMessageCount: 0, largestCanonicalAnswerNumber: null };

  function getConversationId() {
    // Also covers project and custom GPT URLs containing /c/<id>.
    return location.pathname.match(/(?:^|\/)c\/([^/]+)/)?.[1] ?? null;
  }

  function normalizeTimestamp(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || value == null) return null;
    const number = Number(value);
    const milliseconds = Number.isFinite(number) ? (number < 1e12 ? number * 1000 : number) : Date.parse(value);
    return Number.isFinite(milliseconds) && milliseconds > 0 && !Number.isNaN(new Date(milliseconds).getTime()) ? milliseconds : null;
  }

  function getModel(message) {
    const metadata = message.metadata;
    const candidates = [metadata?.resolved_model_slug, metadata?.server_ste_metadata?.model_slug, metadata?.model_slug];
    return candidates.find((value) => typeof value === 'string' && value.trim()) ?? null;
  }

  // New-shell committed Fiber / snapshot lookup adapted from Hangzhi's MIT-licensed
  // fix bafbe3bc045e075eef0cef5bc19b89da74128383 (2026-09-27).
  // https://github.com/Hangzhi/chatgpt-timestamp-extension/blob/bafbe3bc045e075eef0cef5bc19b89da74128383/src/content.js
  function ownValue(object, key) {
    if (!object || typeof object !== 'object' || !Object.prototype.hasOwnProperty.call(object, key)) return undefined;
    return object[key];
  }

  function getCommittedFiber(domNode) {
    const fiberKey = Object.keys(domNode).find((key) => key.startsWith('__reactFiber$'));
    if (!fiberKey) return null;

    const originalPath = [];
    const seen = new Set();
    let fiber = ownValue(domNode, fiberKey);
    let root = null;
    for (let depth = 0; fiber && depth < 400; depth++) {
      if (seen.has(fiber)) return null;
      seen.add(fiber);
      originalPath.push(fiber);
      if (ownValue(fiber, 'tag') === 3) {
        const rootState = ownValue(fiber, 'stateNode');
        const current = ownValue(rootState, 'current');
        if (current === fiber || current === ownValue(fiber, 'alternate')) {
          root = { fiber, state: rootState, current };
          break;
        }
      }
      fiber = ownValue(fiber, 'return');
    }
    if (!root) return null;

    const committedPath = [root.current];
    let committedParent = root.current;
    let work = 0;
    for (let pathIndex = originalPath.length - 2; pathIndex >= 0; pathIndex--) {
      const wanted = originalPath[pathIndex];
      const alternate = ownValue(wanted, 'alternate');
      const siblingSeen = new Set();
      const matches = [];
      let child = ownValue(committedParent, 'child');
      for (let siblings = 0; child && siblings < 1024; siblings++) {
        if (++work > 4096 || siblingSeen.has(child)) return null;
        siblingSeen.add(child);
        if (child === wanted || child === alternate) matches.push(child);
        child = ownValue(child, 'sibling');
      }
      if (child || matches.length !== 1) return null;
      committedParent = matches[0];
      committedPath.push(committedParent);
    }

    if (ownValue(root.state, 'current') !== root.current) return null;
    const views = committedPath.map((committedFiber) => ({
      memoizedProps: ownValue(committedFiber, 'memoizedProps'),
      memoizedState: ownValue(committedFiber, 'memoizedState'),
      updateQueue: ownValue(committedFiber, 'updateQueue'),
      return: null,
    }));
    for (let i = 1; i < views.length; i++) views[i].return = views[i - 1];
    return views[views.length - 1];
  }

  function getTurnEntry(committedFiber, conversationId) {
    let fiber = committedFiber;
    const seen = new Set();
    for (let depth = 0; fiber && depth < 32; depth++) {
      if (seen.has(fiber)) return null;
      seen.add(fiber);
      const props = fiber.memoizedProps;
      const entry = ownValue(props, 'entry');
      const turn = ownValue(entry, 'turn');
      const items = ownValue(turn, 'items');
      if (Array.isArray(items) && ownValue(entry, 'conversationId') === conversationId) {
        const entryId = ownValue(entry, 'id');
        if (typeof entryId !== 'string' || !entryId) return null;

        return { entry, turn, items };
      }
      fiber = fiber.return;
    }
    return null;
  }

  function isSnapshotCandidate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.prototype.hasOwnProperty.call(value, 'renderedConversation') && Object.prototype.hasOwnProperty.call(value, 'renderedTurns');
  }

  function findLiveSnapshot(committedFiber, turnInfo) {
    const candidates = [];
    let remaining = 2048;
    const addCandidate = (value) => {
      if (isSnapshotCandidate(value)) {
        candidates.push(value);
      }
    };
    const inspectMemoCache = (memoData) => {
      if (!Array.isArray(memoData) || memoData.length > 32) return true;
      for (const row of memoData) {
        if (!Array.isArray(row) || row.length > 1024) continue;
        for (const value of row) {
          if (--remaining < 0) return false;
          addCandidate(value);
        }
      }
      return true;
    };

    const seenFibers = new Set();
    let owner = committedFiber;
    owners: for (let depth = 0; owner && depth < 400; depth++, owner = owner.return) {
      if (seenFibers.has(owner)) return null;
      seenFibers.add(owner);
      if (ownValue(owner.memoizedProps, 'conversationId') !== turnInfo.entry.conversationId) continue;

      let hook = owner.memoizedState;
      const seenHooks = new Set();
      while (hook && remaining > 0) {
        if (seenHooks.has(hook)) return null;
        seenHooks.add(hook);
        remaining--;
        const state = ownValue(hook, 'memoizedState');
        addCandidate(state);
        if (Array.isArray(state)) addCandidate(state[0]);
        hook = ownValue(hook, 'next');
      }
      if (hook || remaining <= 0) break owners;

      const updateQueue = owner.updateQueue;
      const memoCache = ownValue(updateQueue, 'memoCache');
      const memoData = ownValue(memoCache, 'data');
      if (!inspectMemoCache(memoData)) break owners;
    }

    const valid = [];
    for (const snapshot of candidates) {
      const renderedConversation = ownValue(snapshot, 'renderedConversation');
      const renderedTurns = ownValue(snapshot, 'renderedTurns');
      const mapping = ownValue(renderedConversation, 'mapping');
      if (!mapping || typeof mapping !== 'object' || !Array.isArray(renderedTurns)) continue;

      const matchingTurns = renderedTurns.filter((turn) => ownValue(turn, 'id') === ownValue(turnInfo.entry, 'id') && ownValue(turn, 'turn') === turnInfo.turn);
      if (matchingTurns.length !== 1) continue;

      const userNode = ownValue(mapping, turnInfo.userId);
      const userMessage = ownValue(userNode, 'message');
      if (ownValue(userNode, 'id') !== turnInfo.userId || ownValue(userMessage, 'id') !== turnInfo.userId || ownValue(ownValue(userMessage, 'author'), 'role') !== 'user') continue;
      valid.push({ snapshot, mapping, renderedConversation });
    }
    if (!valid.length) return null;

    const firstMapping = valid[0].mapping;
    if (valid.some((candidate) => candidate.mapping !== firstMapping)) return null;
    const currentNodeValues = valid.map((candidate) => ({ present: Object.prototype.hasOwnProperty.call(candidate.renderedConversation, 'current_node'), value: ownValue(candidate.renderedConversation, 'current_node') })).filter((candidate) => candidate.present);
    if (currentNodeValues.some((candidate) => !Object.is(candidate.value, currentNodeValues[0].value))) return null;
    return { mapping: firstMapping, renderedTurns: ownValue(valid[0].snapshot, 'renderedTurns') };
  }

  function getBranchTurnNumber(mapping, id, cache = new Map()) {
    const path = [];
    const seen = new Set();
    let nodeId = id;
    while (nodeId != null && !cache.has(nodeId)) {
      if (seen.has(nodeId) || !Object.prototype.hasOwnProperty.call(mapping, nodeId)) return null;
      seen.add(nodeId);
      const node = mapping[nodeId];
      if (!node || !Object.prototype.hasOwnProperty.call(node, 'parent')) return null;
      if (node.parent !== null && (typeof node.parent !== 'string' || !node.parent)) return null;
      // A detached user/assistant message is a truncated history boundary, not
      // proof that this conversation started there.
      if (node.parent === null && node.message && node.message.author?.role !== 'system') return null;
      path.push({ id: nodeId, node });
      nodeId = node.parent;
    }
    let state = nodeId == null ? { count: 0, hasUser: false, answered: false } : cache.get(nodeId);
    for (const item of path.reverse()) {
      const message = item.node.message;
      state = { ...state };
      if (message && !message.metadata?.is_visually_hidden_from_conversation) {
        if (message.author?.role === 'user') {
          state.hasUser = true;
          state.answered = false;
        } else if (message.author?.role === 'assistant' && state.hasUser && !state.answered) {
          // Reasoning, tool calls and final output after one prompt form one answer.
          state.count += 1;
          state.answered = true;
        }
      }
      cache.set(item.id, state);
    }
    return state?.hasUser && state.answered && state.count > 0 ? state.count : null;
  }

  function readConversation(data) {
    if (!data?.mapping || typeof data.mapping !== 'object' || Array.isArray(data.mapping)) {
      throw new Error('Unsupported conversation response');
    }

    const messages = new Map();
    const partial = typeof data.current_node !== 'string' || !Object.prototype.hasOwnProperty.call(data.mapping, data.current_node) || data.is_partial === true || data.has_more === true || data.has_more_before === true || data.pagination?.has_more === true;
    const branchCache = new Map();
    for (const node of Object.values(data.mapping)) {
      const message = node?.message;
      if (typeof message?.id !== 'string' || message.author?.role !== 'assistant') continue;
      messages.set(message.id, {
        timestamp: normalizeTimestamp(message.create_time),
        model: getModel(message),
        turnNumber: partial ? null : getBranchTurnNumber(data.mapping, node.id ?? message.id, branchCache),
      });
    }
    return messages;
  }

  function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatModel(slug) {
    if (typeof slug !== 'string' || !slug.trim()) return null;
    return slug
      .trim()
      .replace(/^gpt-(\d+)-(\d+)(?=-|$)/i, 'GPT-$1.$2')
      .replace(/^gpt-/i, 'GPT-')
      .replace(/^(GPT-[^-]+)-auto(?=-(?:thinking|pro|instant|mini|nano|max)$)/i, '$1')
      .replace(/-(thinking|pro|instant|mini|nano|max|auto)$/i, (_, tier) => ` ${tier[0].toUpperCase()}${tier.slice(1).toLowerCase()}`);
  }

  function getAssistantMessages() {
    const seen = new Set();
    const messages = [];
    for (const candidate of document.querySelectorAll(MESSAGE_SELECTOR)) {
      // In the new transcript, the role heading is a sibling of the selection
      // container. Insert into the visible container, never into that sr-only heading.
      const element = candidate.matches(SELECTION_SELECTOR) ? candidate : (candidate.querySelector(SELECTION_SELECTOR) ?? candidate);
      const ownerId = element.getAttribute('data-chatgpt-selection-conversation-id');
      if (ownerId && ownerId !== conversationId) continue;
      const unit = element.closest(SEARCH_SELECTOR) ?? element;
      const roleElement = element.matches(ROLE_SELECTOR) ? element : (element.closest(ROLE_SELECTOR) ?? element.querySelector(ROLE_SELECTOR) ?? unit.querySelector(ROLE_SELECTOR));
      const role = roleElement?.getAttribute('data-message-author-role') ?? roleElement?.getAttribute('data-conversation-role');
      const unitKey = unit.getAttribute('data-chatgpt-search-unit-key') ?? unit.getAttribute('data-content-search-unit-key');
      if (role ? role !== 'assistant' : !unitKey?.endsWith(':assistant')) continue;

      const directId = element.getAttribute('data-message-id') ?? element.getAttribute('data-chatgpt-selection-message-id');
      const searchIds = (unit.getAttribute('data-chatgpt-search-message-ids') ?? '').split(/\s+/).filter(Boolean);
      const id = directId || searchIds.at(-1);
      if (!id || seen.has(id) || element.closest('[hidden], [aria-hidden="true"]')) continue;
      const ids = [...new Set([id, ...searchIds])];
      seen.add(id);
      messages.push({ id, ids, element });
    }
    return messages;
  }

  function getMessageMetadata({ id, ids, element }, liveByElement) {
    const live = liveByElement?.get(element);
    if (live) {
      const saved = metadataById.get(live.resolvedId);
      return {
        timestamp: live.timestamp ?? saved?.timestamp,
        model: live.model ?? saved?.model,
        // renderedConversation is a projection and may have a synthetic root.
        // Numbers come from complete history or a path anchored to known history.
        turnNumber: saved?.turnNumber ?? live.turnNumber ?? null,
      };
    }
    const direct = metadataById.get(id);
    if (direct) return direct;
    // The selection ID is authoritative. Another grouped message can be reasoning
    // or a tool call; it must not supply the selected final answer's time/model.
    if (element.hasAttribute('data-chatgpt-selection-message-id')) return null;
    const candidates = ids.map((key) => metadataById.get(key)).filter(Boolean);
    return candidates.length === 1 ? candidates[0] : null;
  }

  function collectLiveMetadata(messages) {
    const liveByElement = new Map();
    liveDiagnostics = { visibleAssistantCount: messages.length, committedTurnCount: 0, entryCount: 0, snapshotCount: 0, resolvedMessageCount: 0, largestRenderedNodeCount: 0, largestRenderedTurnCount: 0 };
    const turnCache = new Map();
    for (const message of messages) {
      const saved = metadataById.get(message.id);
      if (saved?.turnNumber != null && saved.timestamp != null && saved.model) continue;
      const turn = message.element.closest('[data-turn-key]');
      if (!turn) continue;
      if (!turnCache.has(turn)) {
        const committed = getCommittedFiber(turn);
        if (committed) liveDiagnostics.committedTurnCount++;
        const info = committed && getTurnEntry(committed, conversationId);
        if (info) liveDiagnostics.entryCount++;
        let snapshot = null;
        if (info) {
          const users = info.items.filter((item) => ownValue(item, 'type') === 'user-message');
          if (users.length === 1) {
            info.userId = ownValue(users[0], 'messageId') || ownValue(users[0], 'serverMessageId');
            if (typeof info.userId === 'string' && info.userId) snapshot = findLiveSnapshot(committed, info);
          }
        }
        if (snapshot) {
          liveDiagnostics.snapshotCount++;
          liveDiagnostics.largestRenderedNodeCount = Math.max(liveDiagnostics.largestRenderedNodeCount, Object.keys(snapshot.mapping).length);
          liveDiagnostics.largestRenderedTurnCount = Math.max(liveDiagnostics.largestRenderedTurnCount, snapshot.renderedTurns.length);
        }
        turnCache.set(turn, snapshot && { info, mapping: snapshot.mapping });
      }
      const context = turnCache.get(turn);
      if (!context) continue;
      const { info, mapping } = context;
      const unitIds = new Set(message.ids);
      const candidates = [];
      for (const item of info.items) {
        if (ownValue(item, 'type') !== 'assistant-message') continue;
        for (const id of new Set([ownValue(item, 'messageId'), ownValue(item, 'latestMessageId')])) {
          if (!unitIds.has(id)) continue;
          const node = ownValue(mapping, id);
          const data = ownValue(node, 'message');
          if (ownValue(node, 'id') !== id || ownValue(data, 'id') !== id || ownValue(ownValue(data, 'author'), 'role') !== 'assistant') continue;
          candidates.push({ id, data, final: ownValue(item, 'phase') === 'final_answer' });
        }
      }
      const finals = candidates.filter((item) => item.final);
      const preferred = finals.length ? finals : candidates;
      const selected = preferred.filter((item) => item.id === message.id);
      const chosen = selected.length ? selected : preferred;
      if (new Set(chosen.map((item) => item.id)).size !== 1) continue;
      const candidate = chosen[0];
      const anchors = new Map();
      for (const [id, data] of metadataById) {
        if (data.turnNumber != null) anchors.set(id, { count: data.turnNumber, hasUser: true, answered: true });
      }
      for (const [id, number] of userTurns) anchors.set(id, { count: number - 1, hasUser: true, answered: false });
      // Require a real known ancestor, never the render window's synthetic root.
      let cursor = candidate.id;
      const seen = new Set();
      while (cursor && !anchors.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor);
        cursor = ownValue(ownValue(mapping, cursor), 'parent');
      }
      const turnNumber = anchors.has(cursor) ? getBranchTurnNumber(mapping, candidate.id, anchors) : null;
      if (turnNumber != null) metadataById.set(candidate.id, { timestamp: normalizeTimestamp(candidate.data.create_time), model: getModel(candidate.data), turnNumber });
      liveDiagnostics.resolvedMessageCount++;
      liveByElement.set(message.element, {
        resolvedId: candidate.id,
        timestamp: normalizeTimestamp(candidate.data.create_time),
        model: getModel(candidate.data),
        turnNumber,
      });
    }
    return liveByElement;
  }

  function appendPart(container, text, color) {
    if (container.childNodes.length) {
      const separator = document.createElement('span');
      separator.textContent = ' · ';
      separator.style.color = 'var(--text-secondary, #abb2bf)';
      container.appendChild(separator);
    }
    const part = document.createElement('span');
    part.textContent = text;
    part.style.color = color;
    container.appendChild(part);
  }

  function renderMetadata(messages, liveByElement) {
    const elements = new Set(messages.map(({ element }) => element));
    document.querySelectorAll(`.${METADATA_CLASS}`).forEach((badge) => {
      if (!elements.has(badge.parentElement)) badge.remove();
    });

    messages.forEach((message) => {
      const { id, element } = message;
      const data = getMessageMetadata(message, liveByElement);
      const modelElement = element.hasAttribute('data-message-model-slug') ? element : (element.querySelector('[data-message-model-slug]') ?? element.closest('[data-message-model-slug]'));
      const model = formatModel(data?.model ?? modelElement?.getAttribute('data-message-model-slug'));
      const timestamp = data?.timestamp;
      const turnNumber = data?.turnNumber;
      const signature = JSON.stringify([id, model, timestamp, turnNumber]);
      let badge = element.querySelector(`:scope > .${METADATA_CLASS}`);
      if (!model && timestamp == null && turnNumber == null) {
        badge?.remove();
        return;
      }
      if (badge?.dataset.signature === signature) return;

      if (!badge) {
        badge = document.createElement('span');
        badge.className = METADATA_CLASS;
        badge.style.cssText = "font-size: 0.8rem; font-weight: 600; margin-bottom: 2px; display: block; align-self: stretch; text-align: right; font-family: 'Maple Mono NF CN', 'JetBrains Mono', Menlo, monospace;";
        element.insertBefore(badge, element.firstChild);
      }
      badge.dataset.signature = signature;
      badge.replaceChildren();
      if (model) appendPart(badge, model, COLORS.model);
      if (timestamp != null) appendPart(badge, formatTimestamp(timestamp), COLORS.timestamp);
      if (turnNumber != null) appendPart(badge, String(turnNumber), COLORS.turnNumber);
      badge.title = timestamp == null ? 'Message timestamp is unavailable.' : turnNumber == null ? 'The full message ancestry is unavailable; the answer number is omitted.' : '';
    });
  }

  function syncConversation() {
    const id = getConversationId();
    if (id === conversationId) return;
    if (conversationId) conversationCaches.set(conversationId, { metadataById, userTurns });
    conversationId = id;
    routeEpoch++;
    metadataById = conversationCaches.get(id)?.metadataById ?? new Map();
    userTurns = conversationCaches.get(id)?.userTurns ?? new Map();
    while (conversationCaches.size > 4) conversationCaches.delete(conversationCaches.keys().next().value);
    lastFetchError = null;
    historyDiagnostics = { canonicalNodeCount: 0, numberedMessageCount: 0, largestCanonicalAnswerNumber: null };
    request?.controller.abort();
    request = null;
    document.querySelectorAll(`.${METADATA_CLASS}`).forEach((badge) => badge.remove());
  }

  function updateMetadata() {
    if (disposed) return;
    syncConversation();
    const messages = getAssistantMessages();
    const liveByElement = collectLiveMetadata(messages);
    renderMetadata(messages, liveByElement);
  }

  function scheduleRender() {
    // Throttle instead of debounce: streaming DOM updates must not starve rendering.
    if (disposed || renderTimer !== undefined) return;
    renderTimer = window.setTimeout(() => {
      renderTimer = undefined;
      updateMetadata();
    }, 100);
  }

  function readFlatMessage(item) {
    const message = item?.message ?? item;
    const id = item?.id ?? message?.id;
    if (typeof id !== 'string' || typeof message?.author?.role !== 'string') throw new Error('Unsupported message list entry');
    const owners = [item, message];
    let parent;
    for (const owner of owners) {
      for (const key of ['parent', 'parent_message_id']) {
        if (Object.prototype.hasOwnProperty.call(owner, key)) {
          parent = owner[key];
          break;
        }
      }
      if (parent !== undefined) break;
    }
    if (parent !== undefined && parent !== null && typeof parent !== 'string') throw new Error('Unsupported message parent');
    // Retain metadata only, not message text, attachments, or complete responses.
    return {
      id,
      messageId: typeof message.id === 'string' ? message.id : id,
      role: message.author.role,
      timestamp: normalizeTimestamp(message.create_time),
      model: getModel(message),
      hidden: message.metadata?.is_visually_hidden_from_conversation === true,
      parent,
    };
  }

  function readFlatHistory(records, currentNode, complete) {
    const byId = new Map();
    const messages = new Map();
    for (const record of records) {
      byId.set(record.id, record);
      if (record.role === 'assistant') messages.set(record.messageId, { timestamp: record.timestamp, model: record.model, turnNumber: null });
    }
    const current = byId.get(currentNode) ?? records.find((record) => record.messageId === currentNode);
    if (!complete || !current) return { messages, complete: false };

    let path;
    if (records.some((record) => typeof record.parent === 'string' && record.parent)) {
      path = [];
      const seen = new Set();
      let record = current;
      while (record) {
        if (seen.has(record.id) || record.parent === undefined) return { messages, complete: false };
        seen.add(record.id);
        path.push(record);
        if (record.parent === null) break;
        record = byId.get(record.parent);
        if (!record) return { messages, complete: false };
      }
      path.reverse();
    } else {
      // The observed endpoint returns the selected branch in path order.
      // Timestamps are not a topology: clocks and tool completion can be out of order.
      const ordered = [...records];
      if (ordered[0]?.id === current.id && ordered.length > 1) {
        ordered.reverse();
      } else if (ordered.at(-1)?.id !== current.id) {
        return { messages, complete: false };
      }
      const index = ordered.findIndex((record) => record.id === current.id);
      path = ordered.slice(0, index + 1);
    }

    const userTurns = new Map();
    let count = 0;
    let hasUser = false;
    let answered = false;
    for (const record of path) {
      if (record.hidden) continue;
      if (record.role === 'user') {
        hasUser = true;
        answered = false;
        userTurns.set(record.messageId, count + 1);
      } else if (record.role === 'assistant' && hasUser) {
        if (!answered) count++;
        answered = true;
        messages.get(record.messageId).turnNumber = count;
      }
    }
    return { messages, userTurns, complete: true };
  }

  function projectHistory(data) {
    const projectMessage = (message) =>
      message && {
        id: message.id,
        author: { role: message.author?.role },
        create_time: message.create_time,
        metadata: { resolved_model_slug: getModel(message), is_visually_hidden_from_conversation: message.metadata?.is_visually_hidden_from_conversation },
      };
    const result = {
      conversation_id: data.conversation_id ?? data.id,
      current_node: data.current_node,
      page_info: data.page_info && { ...data.page_info },
      is_partial: data.is_partial,
      has_more: data.has_more,
      has_more_before: data.has_more_before,
      pagination: data.pagination && { has_more: data.pagination.has_more },
    };
    if (Array.isArray(data.messages))
      result.messages = data.messages.map((item) => {
        const message = projectMessage(item.message ?? item);
        const record = item.message ? { id: item.id, message } : message;
        for (const key of ['parent', 'parent_message_id']) {
          if (Object.prototype.hasOwnProperty.call(item, key)) record[key] = item[key];
          else if (item.message && Object.prototype.hasOwnProperty.call(item.message, key)) record[key] = item.message[key];
        }
        return record;
      });
    if (data.mapping && typeof data.mapping === 'object') result.mapping = Object.fromEntries(Object.entries(data.mapping).map(([id, node]) => [id, { id: node?.id, parent: node?.parent, message: projectMessage(node?.message) }]));
    return result;
  }

  async function requestConversationJson(url, signal, send) {
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw new Error('Conversation request aborted');
      try {
        response = await send(url, signal);
      } catch {
        if (signal.aborted || attempt === 2) throw new Error('Conversation request failed (network)');
        response = null;
      }
      if (response?.ok) break;
      if (response && (attempt === 2 || (response.status !== 429 && response.status < 500))) throw new Error(`Conversation request failed (${response.status})`);
      const retryAfter = response?.headers.get('Retry-After');
      const seconds = Number(retryAfter);
      const retryDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
      const delay = response?.status === 429 ? Math.max(30000, Number.isFinite(retryDelay) ? retryDelay : 0) : 1500 * (attempt + 1);
      await new Promise((resolve, reject) => {
        const stop = () => {
          window.clearTimeout(timer);
          reject(new Error('Conversation request aborted'));
        };
        const timer = window.setTimeout(() => {
          signal.removeEventListener('abort', stop);
          resolve();
        }, delay);
        signal.addEventListener('abort', stop, { once: true });
      });
    }
    return projectHistory(await response.json());
  }

  async function fetchConversation(id, signal, first, base, send) {
    if (!first.mapping && (first.page_info?.has_previous_page === true || first.page_info?.has_next_page === true)) {
      first = await requestConversationJson(base, signal, send);
    }
    if ((first.conversation_id ?? first.id) != null && (first.conversation_id ?? first.id) !== id) throw new Error('Conversation response belongs to another conversation');
    if (first.mapping && typeof first.mapping === 'object' && !Array.isArray(first.mapping)) {
      const messages = readConversation(first);
      return { messages, nodeCount: Object.keys(first.mapping).length, pageCount: 1, schema: 'mapping', endpoint: 'conversations', complete: [...messages.values()].some((value) => value.turnNumber != null) };
    }
    if (!Array.isArray(first.messages)) throw new Error('Unsupported conversation response');
    const currentNode = first.current_node;
    const pages = [];
    const cursors = new Set();
    let page = first;
    let messageCount = 0;
    let oldestComplete = false;
    while (true) {
      if (signal.aborted) throw new Error('Conversation request aborted');
      const ownerId = page.conversation_id ?? page.id;
      if (ownerId != null && ownerId !== id) throw new Error('Conversation response belongs to another conversation');
      if (page.current_node != null && page.current_node !== currentNode) throw new Error('Conversation changed while loading history');
      if (!Array.isArray(page.messages)) throw new Error('Unsupported history page');
      const records = page.messages.map(readFlatMessage);
      messageCount += records.length;
      if (messageCount > MAX_HISTORY_MESSAGES) throw new Error('Conversation history exceeded the message limit');
      pages.push(records);
      const info = page.page_info;
      if (info?.has_previous_page === false) {
        oldestComplete = true;
        break;
      }
      if (info?.has_previous_page !== true) break;
      const cursor = info.start_cursor;
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('Missing or repeated history cursor');
      if (!records.length || pages.length >= MAX_HISTORY_PAGES) throw new Error('Conversation history exceeded the page limit');
      cursors.add(cursor);
      page = await requestConversationJson(`${base}&before=${encodeURIComponent(cursor)}`, signal, send);
    }

    const byId = new Map();
    const newestFirst = pages[0].length > 1 && (pages[0][0].id === currentNode || pages[0][0].messageId === currentNode);
    for (const pageRecords of [...pages].reverse()) {
      const records = newestFirst ? [...pageRecords].reverse() : pageRecords;
      for (const record of records) {
        const existing = byId.get(record.id);
        if (existing && (existing.role !== record.role || existing.messageId !== record.messageId || existing.parent !== record.parent)) throw new Error('Conflicting history pages');
        byId.set(record.id, record);
      }
    }
    const records = [...byId.values()];
    const complete = oldestComplete && first.page_info?.has_next_page === false && first.is_partial !== true && first.has_more !== true && first.has_more_before !== true;
    const result = readFlatHistory(records, currentNode, complete);
    return { ...result, nodeCount: records.length, pageCount: pages.length, schema: 'messages', endpoint: 'conversations' };
  }

  async function loadMetadata(first, base, send) {
    if (disposed) return;
    syncConversation();
    if (!conversationId || request || !first || !send) return;
    const current = { id: conversationId, head: first.current_node, controller: new AbortController() };
    request = current;
    const timeout = window.setTimeout(() => current.controller.abort(), REQUEST_TIMEOUT);

    try {
      const result = await fetchConversation(current.id, current.controller.signal, first, base, send);
      // A→B→A navigation invalidates the first request even if the IDs match again.
      if (disposed || request !== current || getConversationId() !== current.id) return;
      // Partial snapshots and late pages must never erase proven numbers.
      for (const [id, data] of result.messages) {
        const old = metadataById.get(id);
        metadataById.set(id, { timestamp: data.timestamp ?? old?.timestamp, model: data.model ?? old?.model, turnNumber: data.turnNumber ?? old?.turnNumber ?? null });
      }
      for (const [id, number] of result.userTurns ?? []) userTurns.set(id, number);
      historyDiagnostics = {
        canonicalNodeCount: result.nodeCount,
        historyPageCount: result.pageCount,
        historySchema: result.schema,
        historyEndpoint: result.endpoint,
        historyComplete: result.complete,
        numberedMessageCount: [...result.messages.values()].filter((data) => data.turnNumber != null).length,
        largestCanonicalAnswerNumber: [...result.messages.values()].reduce((max, data) => (data.turnNumber == null ? max : Math.max(max ?? 0, data.turnNumber)), null),
      };
      lastFetchError = null;
    } catch (error) {
      if (disposed || request !== current || getConversationId() !== current.id) return;
      historyDiagnostics.lastFailedEndpoint = error.endpoint ?? null;
      // Report status only, never URLs, headers, response bodies, or host exceptions.
      lastFetchError = current.controller.signal.aborted ? 'History request aborted or timed out' : /^Conversation |^Unsupported |^Missing |^Conflicting /.test(error.message) ? error.message : 'History request failed';
    } finally {
      window.clearTimeout(timeout);
      if (!disposed && request === current) {
        request = null;
        updateMetadata();
      }
    }
  }

  const observedFetch = function (...args) {
    const result = Reflect.apply(originalFetch, this, args);
    let url;
    try {
      url = new URL(typeof args[0] === 'string' ? args[0] : args[0]?.url, location.href);
    } catch {
      return result;
    }
    const match = url.origin === location.origin && url.pathname.match(/^\/backend-api\/(?:conversations|conversation)\/([^/]+)$/);
    if (!match || (args[1]?.method ?? args[0]?.method ?? 'GET').toUpperCase() !== 'GET') return result;
    const id = decodeURIComponent(match[1]);
    syncConversation();
    const epoch = routeEpoch;
    // Don't delay ChatGPT's fetch promise or consume its original response body.
    void result
      .then(async (response) => {
        if (disposed || !response.ok || epoch !== routeEpoch || getConversationId() !== id) return;
        const data = projectHistory(await response.clone().json());
        if (disposed || epoch !== routeEpoch || getConversationId() !== id) return;
        syncConversation();
        observedResponses++;
        // Refresh available time/model even when the branch number is cached.
        for (const item of data.messages ?? []) {
          const record = readFlatMessage(item);
          if (record.role !== 'assistant') continue;
          const old = metadataById.get(record.messageId);
          metadataById.set(record.messageId, { timestamp: record.timestamp ?? old?.timestamp, model: record.model ?? old?.model, turnNumber: old?.turnNumber ?? null });
        }
        // Deduplicate the same head; a newer selected branch supersedes old work.
        if (request?.head === data.current_node) return;
        if (request) {
          request.controller.abort();
          request = null;
        }
        const head = data.current_node;
        if (head && metadataById.get(head)?.turnNumber != null) {
          scheduleRender();
          return;
        }
        url.searchParams.delete('before');
        url.searchParams.delete('after');
        url.searchParams.set('num_turns', '100');
        url.searchParams.set('include_has_versions', 'true');
        const send = (target, signal) => {
          const init = { ...args[1], signal };
          // Copy request context opaquely; never inspect authentication headers.
          return typeof args[0] === 'object' && args[0] !== null && typeof Request !== 'undefined' && args[0] instanceof Request ? fetch(new Request(new URL(target, location.origin), { method: 'GET', headers: args[0].headers, credentials: args[0].credentials, ...init })) : fetch(target, init);
        };
        await loadMetadata(data, url.pathname + url.search, send);
      })
      .catch(() => {
        if (!disposed && epoch === routeEpoch) lastFetchError = 'Unable to read observed conversation history';
      });
    return result;
  };
  window.fetch = observedFetch;

  const observer = new MutationObserver((records) => {
    const relevant = records.filter((record) => {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (target?.closest(`.${METADATA_CLASS}`)) return false;
      if (record.type !== 'childList') return true;
      // Ignore our own badges to prevent feedback loops and unnecessary API requests.
      return [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType !== 1 || !node.matches(`.${METADATA_CLASS}`));
    });
    if (!relevant.length) return;
    scheduleRender();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-message-id', 'data-message-author-role', 'data-message-model-slug', 'data-chatgpt-selection-message-id', 'data-chatgpt-selection-conversation-id', 'data-chatgpt-search-message-ids', 'data-chatgpt-search-unit-key', 'data-content-search-unit-key', 'data-conversation-role', 'data-turn-key'],
  });

  const historyMethods = new Map();
  for (const name of ['pushState', 'replaceState']) {
    if (typeof window.history?.[name] !== 'function') continue;
    const original = window.history[name];
    const wrapped = function (...args) {
      const result = Reflect.apply(original, this, args);
      syncConversation();
      scheduleRender();
      return result;
    };
    historyMethods.set(name, { original, wrapped });
    window.history[name] = wrapped;
  }
  function routeChanged() {
    syncConversation();
    scheduleRender();
  }
  window.addEventListener('popstate', routeChanged);
  window.addEventListener('online', recover);
  document.addEventListener('visibilitychange', recover);

  function recover() {
    if (document.visibilityState === 'hidden') return;
    scheduleRender();
  }

  window[INSTANCE_KEY] = () => {
    disposed = true;
    observer.disconnect();
    request?.controller.abort();
    if (window.fetch === observedFetch) window.fetch = originalFetch;
    for (const [name, { original, wrapped }] of historyMethods) if (window.history[name] === wrapped) window.history[name] = original;
    window.clearTimeout(renderTimer);
    window.removeEventListener('popstate', routeChanged);
    window.removeEventListener('online', recover);
    document.removeEventListener('visibilitychange', recover);
    conversationCaches.clear();
    metadataById.clear();
    userTurns.clear();
  };

  window[INSTANCE_KEY].diagnostics = () => ({ numberingSource: 'observed-conversation-history', observedResponses, ...liveDiagnostics, ...historyDiagnostics, cachedNumberedMessageCount: [...metadataById.values()].filter((data) => data.turnNumber != null).length, historyRequestInFlight: request !== null, lastFetchError });

  updateMetadata();
})();
