// Forked from https://github.com/Hangzhi/chatgpt-timestamp-extension

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIMESTAMP_CLASS = 'chatgpt-timestamp';
const METADATA_COLORS = {
  model: '#98c379',
  timestamp: '#56b6c2',
  turnNumber: '#e06c75',
  separator: '#ffffff',
  fontFamily: "'Maple Mono NF CN', 'JetBrains Mono', Menlo",
};

function getMessage(div) {
  const reactKey = Object.keys(div).find((key) => key.startsWith('__reactFiber$'));
  if (!reactKey) return null;

  let node = div[reactKey];
  for (let depth = 0; depth < 15 && node; depth += 1) {
    const message = node.memoizedProps?.messages?.[0];
    if (message?.create_time) return message;
    node = node.return;
  }

  return null;
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp * 1000);
  const format = (value) => String(value).padStart(2, '0');

  return `${date.getFullYear()}-${format(date.getMonth() + 1)}-${format(date.getDate())} ${WEEKDAYS[date.getDay()]} ${format(date.getHours())}:${format(date.getMinutes())}`;
}

function formatModel(modelSlug) {
  if (!modelSlug) return null;

  return modelSlug.replace(/gpt-(\d+)-(\d+)(?:-(\w+))?/i, (_, major, minor, type) => {
    const suffix = type ? ` ${type.charAt(0).toUpperCase()}${type.slice(1)}` : '';
    return `GPT-${major}.${minor}${suffix}`;
  });
}

function getTurnNumber(div) {
  const section = div.closest('section[data-testid^="conversation-turn-"]');
  const match = section?.dataset.testid?.match(/^conversation-turn-(\d+)$/);
  if (!match) return null;

  return Math.ceil(Number(match[1]) / 2);
}

function appendMetadataPart(container, text, color, prependSeparator) {
  if (prependSeparator) {
    const separator = document.createElement('span');
    separator.textContent = ' · ';
    separator.style.color = METADATA_COLORS.separator;
    container.appendChild(separator);
  }

  const part = document.createElement('span');
  part.textContent = text;
  part.style.color = color;
  container.appendChild(part);
}

function addMetadata() {
  const assistantMessages = [];

  document.querySelectorAll('div[data-message-id]').forEach((div) => {
    const message = getMessage(div);
    if (!message?.create_time || message.author?.role !== 'assistant') return;

    assistantMessages.push({ div, message });
  });

  assistantMessages.forEach(({ div, message }, index) => {
    const model = formatModel(div.dataset.messageModelSlug);
    const turnNumber = getTurnNumber(div) ?? index + 1;
    const signature = `${model ?? ''}|${message.create_time}|${turnNumber}`;
    let metadata = div.querySelector(`:scope > .${TIMESTAMP_CLASS}`);

    if (metadata?.dataset.signature === signature) return;

    if (!metadata) {
      metadata = document.createElement('span');
      metadata.className = TIMESTAMP_CLASS;
      div.insertBefore(metadata, div.firstChild);
    }

    metadata.style.cssText = `
      font-size: 0.8rem;
      margin-right: 1rem;
      font-weight: 600;
      margin-bottom: 2px;
      display: inline-block;
      font-family: ${METADATA_COLORS.fontFamily};
    `;

    metadata.replaceChildren();
    metadata.dataset.signature = signature;

    if (model) appendMetadataPart(metadata, model, METADATA_COLORS.model, false);
    appendMetadataPart(metadata, formatTimestamp(message.create_time), METADATA_COLORS.timestamp, Boolean(model));
    appendMetadataPart(metadata, String(turnNumber), METADATA_COLORS.turnNumber, true);
  });
}

let pendingUpdate;
const scheduleMetadataUpdate = () => {
  window.clearTimeout(pendingUpdate);
  pendingUpdate = window.setTimeout(addMetadata, 300);
};

scheduleMetadataUpdate();

const observer = new MutationObserver(scheduleMetadataUpdate);
observer.observe(document.body, { childList: true, subtree: true });
