import type { BaseEvent } from './events.ts';

// Common types used across multiple files
export type StateResult<StateName extends string, TEvent extends BaseEvent> =
  | { status: 'waiting' | 'terminal'; actions?: TEvent[] }
  | { status: 'transition'; actions?: TEvent[]; to?: StateName };

export interface PrepResult<TEvent extends BaseEvent, ARGS> {
  events?: TEvent[];
  args: ARGS;
}
