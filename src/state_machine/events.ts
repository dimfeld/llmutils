export interface BaseEvent<T extends string = string, P = unknown> {
  id: string;
  type: T;
  payload: P;
}

export interface BaseAction<T extends string = string, P = unknown> {
  id: string;
  type: T;
  payload: P;
}

// Helper type for creating discriminated unions
export type Event<T extends string, P> = BaseEvent<T, P>;

// Example usage:
// type AppEvent =
//   | Event<'USER_LOGIN', { username: string; password: string }>
//   | Event<'USER_LOGOUT', void>
//   | Event<'UPDATE_PROFILE', { name: string; email: string }>;
