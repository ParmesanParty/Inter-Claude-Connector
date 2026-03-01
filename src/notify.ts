import { createLogger } from './util/logger.ts';
import type { ICCConfig, InboxMessage } from './types.ts';

const log = createLogger('notify');

let _notifier: { notify(opts: Record<string, unknown>): void } | null | undefined = undefined; // undefined = not yet loaded, null = unavailable

async function getNotifier(): Promise<typeof _notifier> {
  if (_notifier !== undefined) return _notifier;
  try {
    _notifier = (await import('node-notifier')).default;
    log.info('Desktop notifications enabled via node-notifier');
  } catch {
    _notifier = null;
    log.info('node-notifier not available — desktop notifications disabled');
  }
  return _notifier;
}

/**
 * Creates a desktop notification callback for inbox messages.
 * Returns a function compatible with inbox.setNotifier().
 * Lazily loads node-notifier on first notification.
 */
export function createDesktopNotifier(config: ICCConfig): (message: InboxMessage) => void {
  return (message: InboxMessage) => {
    const preview = message.body.length > 100
      ? message.body.slice(0, 97) + '...'
      : message.body;
    getNotifier().then(notifier => {
      if (!notifier) return;
      const titlePrefix = config.instance ? `ICC [${config.instance}]` : 'ICC';
      notifier.notify({
        title: `${titlePrefix}: Message from ${message.from}`,
        message: preview,
        sound: false,
        timeout: 10,
      });
      log.debug(`Desktop notification sent for message from ${message.from}`);
    }).catch((err: Error) => {
      log.error(`Desktop notification failed: ${err.message}`);
    });
  };
}
