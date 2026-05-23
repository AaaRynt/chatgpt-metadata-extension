// fork from https://github.com/Hangzhi/chatgpt-timestamp-extension
let use24HourFormat = localStorage.getItem('chatgpt-timestamps-24h-format') !== 'false';
let useUserOnlyTimestamps = localStorage.getItem('chatgpt-timestamps-user-only') === 'true';

function addExtension() {
  document.querySelectorAll('div[data-message-id]').forEach(div => {
    // Skip if already has timestamp
    if (div.dataset.timestampAdded) return;

    const reactKey = Object.keys(div).find(k => k.startsWith('__reactFiber$'));
    if (!reactKey) return;

    // Walk up the fiber tree to find the component with messages
    let node = div[reactKey];
    let message;
    for (let i = 0; i < 15 && node; i++) {
      const messages = node.memoizedProps?.messages;
      if (messages?.[0]?.create_time) {
        message = messages[0];
        break;
      }
      node = node.return;
    }
    const timestamp = message?.create_time;
    if (!timestamp) return;
    if (useUserOnlyTimestamps && message?.author?.role !== 'user') return;

    const date = new Date(timestamp * 1000);
    const weeks = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const format = n => n.toString().padStart(2, '0');

    const turnNumber = Math.floor(Array.from(document.querySelectorAll('div[data-message-id]')).indexOf(div) / 2) + 1;
    const modelSlug = div.dataset.messageModelSlug;
    const modelText = modelSlug ? modelSlug.replaceAll('-', '.').replace('gpt.', 'GPT-') : null;

    let formatted = [turnNumber];
    let finalTime = '';
    if (use24HourFormat) {
      finalTime = `${date.getFullYear()}-${format(date.getMonth() + 1)}-${format(date.getDate())}  ${weeks[date.getDay()]} ${format(date.getHours())}:${format(date.getMinutes())}`;
    } else {
      let hours = date.getHours();
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      finalTime = `${date.getFullYear()}-${format(date.getMonth() + 1)}-${format(date.getDate())} ${weeks[date.getDay()]} ${format(date.getHours())}:${format(date.getMinutes())} ${ampm}`;
    }
    formatted.push(finalTime);
    if (modelText) formatted.push(modelText);

    const span = document.createElement('span');
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const color = isDark ? '#ffffff' : '#000000';
    span.textContent = formatted.join(' · ');
    span.className = 'chatgpt-timestamp';
    span.style.cssText = `
      font-size: 12px;
      color: ${color};
      margin-right: 8px;
      margin-bottom: 2px;
      display: inline-block;
      font-family: 'JetBrains Mono', 'Maple Mono NF CN', Menlo;
    `;
    div.insertBefore(span, div.firstChild);

    // Mark as processed
    div.dataset.timestampAdded = 'true';
  });
}

function updateTimestamps() {
  // Remove all existing timestamps
  document.querySelectorAll('.chatgpt-timestamp').forEach(span => span.remove());
  document.querySelectorAll('div[data-message-id]').forEach(div => {
    delete div.dataset.timestampAdded;
  });
  // Re-add with new format
  addExtension();
}

// Listen for storage changes
window.addEventListener('storage', (e) => {
  if (e.key === 'chatgpt-timestamps-24h-format') {
    use24HourFormat = e.newValue !== 'false';
    updateTimestamps();
    return;
  }
  if (e.key === 'chatgpt-timestamps-user-only') {
    useUserOnlyTimestamps = e.newValue === 'true';
    updateTimestamps();
  }
});

// Wait for page to fully load
setTimeout(() => {
  addExtension();
}, 3000);

const observer = new MutationObserver(() => {
  setTimeout(addExtension, 500);
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});

// Also run periodically to catch any missed messages
setInterval(addExtension, 5000);
