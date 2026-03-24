export let debug = false;
export let quiet = false;

export function setQuiet(value: boolean | undefined): void {
  quiet = value ?? false;
}

export function setDebug(value: boolean | undefined): void {
  debug = value ?? false;
}
