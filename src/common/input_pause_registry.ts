export interface PausableInputSource {
  pause(): void;
  resume(): void;
}

let activeInputSource: PausableInputSource | undefined;

export function setActiveInputSource(source: PausableInputSource | undefined): void {
  activeInputSource = source;
}

export function getActiveInputSource(): PausableInputSource | undefined {
  return activeInputSource;
}
