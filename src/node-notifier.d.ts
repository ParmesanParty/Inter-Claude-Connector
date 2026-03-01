declare module 'node-notifier' {
  const notifier: {
    notify(options: Record<string, unknown>): void;
  };
  export default notifier;
}
