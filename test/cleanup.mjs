const stacks = new WeakMap();

/** Release consumers before their fixture directories, including when an earlier cleanup fails. */
export function deferCleanup(t, action) {
  let stack = stacks.get(t);
  if (!stack) {
    stack = [];
    stacks.set(t, stack);
    t.after(async () => {
      const errors = [];
      for (const cleanup of stack.reverse()) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, "Fixture cleanup failed");
    });
  }
  stack.push(action);
}
