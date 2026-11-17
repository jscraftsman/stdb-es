import type { EventRow } from './tables.js';

/**
 * Functional description of one aggregate kind.
 *
 * The same definition drives replay (`aggregateStream`), the repository's
 * state-cache fallback, and `doctor` repair, so all three can never disagree
 * about how events become state.
 */
export type AggregateDefinition<TState, TEvent> = {
  /** Stream type written to `es_stream` for this aggregate kind. */
  streamType: string;
  /** Fresh state for a stream that does not exist yet. */
  initial: () => TState;
  /** Decodes one stored row into a domain event. Throw on unknown types. */
  decode: (row: EventRow) => TEvent;
  /** Pure state transition. Must be deterministic. */
  evolve: (state: TState, event: TEvent, row: EventRow) => TState;
};

/** Identity helper that keeps the definition's inferred types intact. */
export function defineAggregate<TState, TEvent>(
  definition: AggregateDefinition<TState, TEvent>,
): AggregateDefinition<TState, TEvent> {
  return definition;
}

/**
 * Optional class form, for parity with the classic event-sourcing workshop.
 *
 * Prefer `defineAggregate` plus `Repository` when you want state cache parity
 * with replay; the class form is here for teams that already structure
 * aggregates as objects with behaviour methods.
 */
export abstract class Aggregate<TState, TEvent = unknown> {
  #state: TState;
  #uncommitted: TEvent[] = [];

  constructor(
    readonly id: string,
    initial: TState,
  ) {
    this.#state = initial;
  }

  /** Last committed version this instance represents. */
  version = 0;

  get state(): TState {
    return this.#state;
  }

  /** Replay transition. Must be deterministic and free of side effects. */
  protected abstract evolve(state: TState, event: TEvent): TState;

  /** Decides a new event: applies it and queues it for the next `save`. */
  protected raise(event: TEvent): void {
    this.#state = this.evolve(this.#state, event);
    this.#uncommitted.push(event);
  }

  /** Replays a persisted event. Never queues it for append. */
  apply(event: TEvent, version: number): void {
    this.#state = this.evolve(this.#state, event);
    this.version = version;
  }

  /** Restores state from a trusted cache row. Prefer `apply` while replaying. */
  hydrate(state: TState, version: number): void {
    this.#state = state;
    this.version = version;
  }

  /** Returns queued events and clears the queue. */
  dequeueUncommitted(): TEvent[] {
    const events = this.#uncommitted;
    this.#uncommitted = [];
    return events;
  }

  /** Queued events without clearing them. */
  get uncommitted(): readonly TEvent[] {
    return this.#uncommitted;
  }
}
