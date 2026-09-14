// Static scope chain used by the analyzer — see docs/SPECIFICATION.md §8.
// Deliberately mirrors the runtime Environment (interpreter/interpreter.js)
// one-for-one: both walk a parent chain the same way, because CHANGE's
// resolution rule (§4.3/ADR-002) must be identical to an ordinary read at
// both analysis time and run time.
export class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.bindings = new Map(); // name -> { type }
  }

  hasLocal(name) {
    return this.bindings.has(name);
  }

  getLocal(name) {
    return this.bindings.get(name);
  }

  defineLocal(name, type) {
    this.bindings.set(name, { type });
  }

  // Walks outward (including this scope) and returns { scope, binding } for
  // the nearest binding of `name`, or null if unbound anywhere.
  resolve(name) {
    let scope = this;
    while (scope) {
      if (scope.bindings.has(name)) {
        return { scope, binding: scope.bindings.get(name) };
      }
      scope = scope.parent;
    }
    return null;
  }

  child() {
    return new Scope(this);
  }
}
