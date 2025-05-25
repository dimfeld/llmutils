export interface BaseEvent<T extends string = string, P = unknown> {
  id: string;
  type: T;
  payload?: P;
  /** Optional routing information for event bus */
  targetMachineId?: string;
  sourceMachineId?: string;
}

export interface BaseAction<T extends string = string, P = unknown> {
  id: string;
  type: T;
  payload: P;
}

// Helper type for creating discriminated unions
export type Event<T extends string, P> = P extends undefined
  ? {
      id: string;
      type: T;
      payload?: P;
    }
  : {
      id: string;
      type: T;
      payload: P;
    };

// Example usage:
// type AppEvent =
//   | Event<'USER_LOGIN', { username: string; password: string }>
//   | Event<'USER_LOGOUT', void>
//   | Event<'UPDATE_PROFILE', { name: string; email: string }>;
