export interface BaseEvent {
  id: string;
  type: string;
  payload: unknown;
}

export interface BaseAction {
  id: string;
  type: string;
  payload: unknown;
}
