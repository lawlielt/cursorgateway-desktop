# Cursor Gateway Desktop

Desktop gateway for Cursor capabilities with OpenAI/Anthropic-compatible APIs.

**Platforms:** macOS + Windows

## What this project is

This project is refactored from:
- Upstream: https://github.com/taxue2016/CursorGateway

It is not a mirror. This repo adds desktop productization, packaging, and stability fixes.

## Current release channels

- **macOS:** DMG
- **Windows:** NSIS installer (`*-setup-x64.exe`)

Releases:
- https://github.com/lawlielt/cursorgateway-desktop/releases

## Key features

- Menu/tray desktop app + control panel
- Cursor login flow from GUI
- Health and model checks (`/health`, `/v1/models`)
- One-click Claude Code config import
- Startup UX improvements (boot loading, watchdog recovery)
- Token persistence in user-writable paths

## Quick start

1. Download latest release asset for your OS.
2. Install app:
   - macOS: open DMG and drag app to Applications
   - Windows: run `Cursor Gateway Desktop-<version>-setup-x64.exe`
3. Open app and click **Cursor Login**.
4. Click **Status Check**.
5. Verify `/v1/models` in control panel.

## API base

- Base URL: `http://127.0.0.1:3010`
- OpenAI-compatible: `/v1/chat/completions`
- Anthropic-compatible: `/v1/messages`

## Security notes

- Cursor token is sensitive credential.
- Do not expose token in screenshots/issues/chats.
- Keep service on localhost unless you add your own auth layer.

## Docs

- Chinese README: `README.zh-CN.md`
