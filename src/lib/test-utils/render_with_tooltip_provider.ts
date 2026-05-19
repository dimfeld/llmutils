import { render } from 'svelte/server';
import type { Component } from 'svelte';

import TooltipProviderHarness from './TooltipProviderHarness.svelte';

export function renderWithTooltipProvider(
  component: Component,
  options: { props?: Record<string, unknown> } = {}
): ReturnType<typeof render> {
  return render(TooltipProviderHarness, {
    props: {
      component,
      props: options.props ?? {},
    },
  });
}
