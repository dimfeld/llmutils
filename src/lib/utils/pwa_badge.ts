type AppBadgeNavigator = Navigator & {
  clearAppBadge?: () => Promise<void>;
  setAppBadge?: (contents?: number) => Promise<void>;
};

export function setAppBadge(): void {
  const badgeNavigator = navigator as AppBadgeNavigator;
  void badgeNavigator.setAppBadge?.().catch(() => undefined);
}

export function clearAppBadge(): void {
  const badgeNavigator = navigator as AppBadgeNavigator;
  void badgeNavigator.clearAppBadge?.().catch(() => undefined);
}
