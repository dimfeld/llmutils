// Reactive holder for the shepherd page browser test. The mocked `getProjectPrs` reads it,
// so the page's `$derived(await getProjectPrs(...))` re-runs when a test changes the data.
export const shepherdPageTestState = $state<{ value: unknown; version: number }>({
  value: null,
  version: 0,
});
