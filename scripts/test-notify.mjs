#!/usr/bin/env node
/**
 * claude-auto-resume — verify the optional Telegram notification setup.
 *
 * Reads ~/.claude/auto-resume/notify.json (see README for the format) and
 * sends a real test message. Exits 0 on success, 1 otherwise. Never prints
 * the bot token.
 *
 * Usage:  node scripts/test-notify.mjs
 */
import { loadNotifyConfig, createNotifier, defaultConfigPath } from '../lib/notify.mjs';

const config = loadNotifyConfig();
if (!config) {
  console.error(`no notification config found at ${defaultConfigPath()} — nothing to test.`);
  console.error('Create it with: { "telegram": { "botToken": "...", "chatId": "..." } }');
  process.exit(1);
}

const notifier = createNotifier(config, { log: (m) => console.error(m) });
const ok = await notifier.notify('🔔 Auto-resume notifications enabled');
console.log(ok ? 'test message sent — Telegram API answered ok:true' : 'test message FAILED');
process.exit(ok ? 0 : 1);
