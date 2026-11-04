// Concurrent callers of the same read share ONE request.
//
// /policies mounts several hooks in the same moment (three stage-row hooks, the item
// masters, the data map…), and each asked the database for the same project-wide
// payload on its own. This joins a read that is already running; it remembers nothing
// once that read has settled, so a call made later always reads again.
//
// WHY NO TTL. A cache that outlives its read can hand a page data from before the
// user's own write. Joining only while pending keeps the window to the length of one
// request, and a caller that has just written passes `fresh` to start a new read
// (which later callers may then join). The value is shared, not copied: callers must
// treat it as read-only.
const pending = new Map<string, Promise<unknown>>();

export function shareRead<T>(key: string, read: () => Promise<T>, fresh = false): Promise<T> {
  if (!fresh) {
    const running = pending.get(key);
    if (running) return running as Promise<T>;
  }
  const p = read();
  pending.set(key, p);
  const clear = () => {
    if (pending.get(key) === p) pending.delete(key);
  };
  p.then(clear, clear);
  return p;
}
