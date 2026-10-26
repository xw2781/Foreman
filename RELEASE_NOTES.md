# Foreman 1.0.0

Download **Foreman-Setup-1.0.0.exe** below and run it to install Foreman for your Windows user account. No administrator rights, Node.js, npm, Git, or VS Code installation is required.

Supports **Windows 10 and 11, x64**. macOS, Linux, and native Windows ARM64 installers are not included. The installer is unsigned; download it only from this repository. `SHA256SUMS.txt` contains release asset checksums.

After launching, open **Settings → Command-line tools → Install for Foreman** to download Claude Code and Codex, then sign in. Internet access and the relevant provider accounts are required. Existing CLI installations can also be used.

## Changes since 0.2.0

- Install and update the official Claude Code and Codex tools directly from Settings.
- Browse and test websites with the built-in agent browser, and inspect project files in the side panel.
- Follow subagents and background commands in the live map, with clearer background activity status.
- Group sessions by project, add or remove projects from the panel, and restore them without deleting sessions.
- Use voice input, attachments, chat annotations, effort controls, steering and queued messages.
- Discover available models from installed tools; inspect prompt caching, switching cost estimates, plan usage, and usage from other computers.
- Improve conversation history, unread badges, appearance settings, narrow layouts, and the chat composer.
- Fix wrapped Claude sign-in URLs and avoid speech model setup stalls.

Installed copies can update from this release. The `.blockmap` and `latest.yml` assets support automatic updates; users only need to download the `.exe` installer.

## Validation

- TypeScript type check passed.
- All 210 tests across 31 test files passed.
