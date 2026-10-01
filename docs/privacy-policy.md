# Privacy Policy

## ChatGPT Metadata Extension

**Last updated:** October 2026

## Overview

ChatGPT Metadata Extension processes metadata within the user's browser and does not transmit conversation data to third-party servers. It makes read-only requests to ChatGPT's own service using the user's existing session.

The extension enhances ChatGPT assistant responses by displaying metadata already available in the web application, such as:

- assistant response timestamps
- assistant response model identifiers
- assistant response counters

## Data Handling

This extension:

- does not collect personal information
- does not upload conversation data
- does not transmit prompts or responses to any external service
- does not use local storage to retain conversation data or preferences
- does not use analytics or tracking scripts, or create its own cookies
- does not sell or share user data

The extension first reads the current conversation's live metadata from the page's committed React state. For global answer numbers, it reads ChatGPT's `/backend-api/conversations/{id}` endpoint and its older message pages; it uses the legacy `/backend-api/conversation/{id}` endpoint as a compatibility fallback. When authentication is required, it reads `/api/auth/session` and uses the returned token only for requests to the same ChatGPT origin. These requests may include existing ChatGPT session cookies. While assembling history, the extension retains only message IDs, roles, parent relationships, timestamps, model identifiers, visibility flags, pagination cursors, and the session token in memory; it does not persist the conversation response or session token, or include them in diagnostic logs. Message metadata is cleared when switching conversations.

## Permissions

The extension only runs on ChatGPT conversation pages on these domains:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`

The content script excludes ChatGPT backend API document URLs. Its access is used solely to display metadata alongside assistant responses in the ChatGPT interface.

## Third-Party Services

This extension does not use or integrate with third-party services, analytics platforms, or advertising networks. Its only service requests are to the ChatGPT origin where it is running.

## Open Source

The source code for this extension is publicly available on GitHub.

Users may inspect, modify, or build the extension themselves.

## Contact

For questions, issues, or suggestions, please open an issue on the GitHub repository:

`https://github.com/AaaRynt/chatgpt-metadata-extension`

## Changes to This Policy

Any future updates to this privacy policy will be published in the project's GitHub repository.
