# ChatGPT Metadata Extension

A fork of [ChatGPT Timestamp Extension](https://github.com/Hangzhi/chatgpt-timestamp-extension) that displays metadata on ChatGPT assistant responses.

## Adds

- Assistant message index
- Assistant message timestamps in 24-hour format
- Assistant active model display
- Monospace metadata display
- _One dark_ / _Atom_ style

## Screenshot

![GPT-5.6 Thinking · 2026-08-06 Thu 10:46 · 2](assets/screenshot.png)

<span style="font-size: 0.8rem; font-family: 'Maple Mono NF CN', 'JetBrains Mono', Menlo;"><span style="color:#98c379">GPT-5.6 Thinking</span><span style="color:#ffffff"> · </span><span style="color:#56b6c2">2026-08-06 Thu 10:46</span><span style="color:#ffffff"> · </span><span style="color:#e06c75">2</span></span>

## Manual install for Chrome

1. Download this repo
2. Open `chrome://extensions/`
3. Enable Developer mode
4. Load unpacked → select the `src/` folder
5. Visit ChatGPT

After changing the source, reload the extension in `chrome://extensions/` and refresh the ChatGPT tab. No build step is required.

## How metadata is loaded

The content script starts in the page's main world at `document_start`, before ChatGPT loads its conversation. It observes successful same-origin conversation GET responses without delaying ChatGPT's fetch promise or consuming its response body. It immediately reduces the JSON to message IDs, roles, timestamps, model names, parent links and pagination flags. It does not save conversation text, attachments, session responses or authentication tokens.

The November 2026 browser investigation found that ChatGPT's own authenticated request returned **200**, while an independent extension fetch to the same conversation returned **404**, even with same-origin cookies. The previous implementation treated 404 as an obsolete endpoint and tried a second path; its authentication fallback only ran on 401/403. Consequently it never acquired complete history and suppressed every global number. Scrolling changed the missing-message retry key, repeatedly restarting those unsuccessful requests. This was not a DOM-only scrolling problem.

For the observed `messages[]` schema, the extension uses the selected branch's server order, not timestamp sorting or DOM order. `page_info.has_previous_page` and `start_cursor` drive older-history pagination using `before`. A small initial window is expanded with `num_turns=100`; history is published as globally numbered only after the start and selected head are accounted for. The browser verified that this page size is supported. `metadata.parent_id` is not treated as a complete mapping edge: the observed flat branch contains intermediate reasoning and tool messages. Explicit graph responses still use actual node parent links.

Backfill passes the successful page request's context through opaquely, only to that same observed conversation endpoint. It never extracts an Authorization value, requests `/api/auth/session`, or stores a credential for future requests. The request context is released after the bounded backfill. Each job allows at most 100 history pages, 50,000 messages and 60 seconds. Network/server failures receive at most two retries; rate limits honor `Retry-After`. A 404 does not trigger an invented endpoint fallback or a retry loop.

Each user prompt and its subsequent assistant messages form one answer group. Reasoning, tool activity, intermediate UI messages and final output do not each increment the number. Message IDs identify the displayed answer; a selected final answer never borrows another message's timestamp or model. Numbers and metadata are held in memory independently of mounted DOM elements. Partial responses cannot erase a proven number. A small per-conversation memory cache survives SPA navigation; route changes abort obsolete work and invalidate late results.

For a newly generated or regenerated answer that is not yet in saved history, a bounded React committed-state lookup may supply time/model and connect the selected answer to an already numbered ancestor or known user prompt. A synthetic render root alone is never evidence for answer 1. This fallback only runs for missing metadata; loaded, cached answers do not need React internals. DOM mutations schedule rendering without polling or starting history requests. UI styling, model formatting and timestamp formatting remain unchanged.

Home, temporary-chat and shared pages without a `/c/{id}` URL may only have DOM model information. If the initial history request was missed (for example, after manually injecting the script into an already loaded page), refresh ChatGPT. The implementation depends on internal conversation schemas and message attributes, which can change; unavailable or unproven metadata is omitted.

For counts and status without message text or credentials, run:

```js
window[Symbol.for('chatgpt-metadata-extension')]?.diagnostics();
```

`observedResponses` confirms that a page history response was captured; `historyComplete`, `historyPageCount` and `canonicalNodeCount` describe the last history load. `cachedNumberedMessageCount` includes answers subsequently anchored in live state, and `historyRequestInFlight` identifies an active backfill. React lookup counts can legitimately be zero when all visible metadata is cached.

## Real-browser verification

Verified with the locally installed unpacked extension reloaded, then ChatGPT refreshed, on 2026-11-24. Only designated test conversations were used. No real message text, account data or conversation IDs are included in the fixtures.

- Three long conversations recovered global last-answer numbers 33, 16 and 143. The largest required three history pages; only one to three answers were mounted at once.
- The short conversation displayed 1–3 after refresh; two test prompts produced 4 and 5 without reloading history. Streaming DOM updates were observed, with the final metadata resolving to the same global sequence.
- A test prompt appended to a long conversation received 17. Retrying that answer and editing the test prompt into an alternate branch both retained 17 with different answer IDs. Refreshing preserved the result.
- Real keyboard scrolling moved the 143-answer conversation back through 140, 138 and 137, then forward to 143. Previously mounted elements were replaced; numbers survived and the extension did not start additional backfills.
- SPA navigation between the designated short and long conversations exercised cancellation, conversation scoping and cached rendering.

These checks are evidence for the observed ChatGPT deployment, not a guarantee against future internal changes. The automated fixtures cover the observed structure with invented IDs and no conversation bodies.

## Local checks

Run `node --check src/content.js` and `node --test tests/content.test.cjs`. The regression tests use an in-memory DOM, clock, and API responses; they do not access a browser or the network and require no dependencies.
