// The receivers of the single-app API (start()/join()). Several engines can live in one app
// (Frequencies runs Scala's sync and Kith's sync), and each calls start() with its own onReceive.
// Each receiver opens only the topics it owns and returns false for the rest, so an incoming
// message is offered to every receiver until one opens it.
export type Receiver = (topic: string, candidates: Uint8Array[]) => boolean;

export class Receivers {
  private list: Receiver[] = [];
  // Idempotent per function: an engine that calls start() again with the same handler isn't added twice.
  add(r: Receiver): void { if (!this.list.includes(r)) this.list.push(r); }
  get size(): number { return this.list.length; }
  dispatch(topic: string, candidates: Uint8Array[]): boolean {
    for (const r of this.list) {
      try { if (r(topic, candidates)) return true; } catch { /* one engine's bug must not starve the others */ }
    }
    return false;
  }
}
