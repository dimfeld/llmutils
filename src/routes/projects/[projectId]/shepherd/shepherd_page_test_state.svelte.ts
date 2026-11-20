// Reactive holder for the shepherd page browser test. The mocked `getShepherdPrs` reads it,
// so the page's `$derived(await getShepherdPrs(...))` re-runs when a test changes the data.
export const shepherdPageTestState = $state<{ value: unknown; version: number }>({
  value: null,
  version: 0,
});
