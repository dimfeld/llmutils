<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { projectDisplayName } from '$lib/stores/project.svelte.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { getActionablePrs } from '$lib/remote/dashboard.remote.js';
  import { shouldRefreshProjectPrs } from '$lib/utils/pr_update_events.js';
  import {
    deriveAttentionItems,
    deriveRunningNowSessions,
    deriveReadyToStartPlans,
  } from '$lib/utils/dashboard_attention.js';
  import DashboardSection from '$lib/components/DashboardSection.svelte';
  import NeedsAttentionCard from '$lib/components/NeedsAttentionCard.svelte';
  import PrAttentionCard from '$lib/components/PrAttentionCard.svelte';
  import RunningNowRow from '$lib/components/RunningNowRow.svelte';
  import ReadyToStartRow from '$lib/components/ReadyToStartRow.svelte';
  import type { LayoutProps } from './$types';

  let { data, children, params }: LayoutProps = $props();

  const sessionManager = useSessionManager();

  let projectId = $derived(params.projectId);
  let showProject = $derived(projectId === 'all');

  let selectedPlanUuid = $derived(page.params.planUuid ?? null);
  let selectedPrNumber = $derived(page.params.prNumber ? Number(page.params.prNumber) : null);

  let projectNamesById = $derived.by(() => {
    if (!showProject) return {};
    const map: Record<number, string> = {};
    for (const project of data.projects) {
      map[project.id] = projectDisplayName(project.repository_id, data.currentUsername);
    }
    return map;
  });

  let actionablePrs = $derived(await getActionablePrs({ projectId }));

  let numericProjectId = $derived(projectId === 'all' ? null : Number(projectId));

  let notificationSessions = $derived(
    sessionManager.sessionsWithNotification
      .filter((s) => numericProjectId === null || s.projectId === numericProjectId)
      .map((s) => ({
        connectionId: s.connectionId,
        planUuid: s.sessionInfo.planUuid ?? null,
        planId: s.sessionInfo.planId ?? null,
        planTitle: s.sessionInfo.planTitle ?? null,
        workspacePath: s.sessionInfo.workspacePath ?? null,
        command: s.sessionInfo.command,
        connectedAt: s.connectedAt,
        projectId: s.projectId,
      }))
  );

  let attentionItems = $derived(
    deriveAttentionItems(data.plans, sessionManager.sessions.values(), actionablePrs, notificationSessions)
  );
  let attentionCount = $derived(
    attentionItems.planItems.length + attentionItems.prItems.length + attentionItems.sessionItems.length
  );

  let runningSessions = $derived(
    deriveRunningNowSessions(sessionManager.sessions.values(), projectId)
  );

  let readyPlans = $derived(deriveReadyToStartPlans(data.plans, sessionManager.sessions.values()));

  let allEmpty = $derived(
    attentionCount === 0 && runningSessions.length === 0 && readyPlans.length === 0
  );

  // Subscribe to PR update events to refresh actionable PR data when available
  onMount(() => {
    return sessionManager.onEvent((eventName, event) => {
      if (eventName !== 'pr:updated') return;
      if (!shouldRefreshProjectPrs(event, projectId)) return;
      getActionablePrs({ projectId }).refresh();
    });
  });
</script>

<div class="flex h-full w-full">
  <div class="w-96 shrink-0 overflow-y-auto border-r border-border">
    <div class="space-y-4 p-4">
      {#if allEmpty && sessionManager.initialized}
        <div class="flex flex-col items-center justify-center py-16">
          <p class="text-lg font-medium text-muted-foreground">All clear</p>
          <p class="mt-1 text-sm text-muted-foreground">No items need attention right now.</p>
        </div>
      {:else}
        {#if attentionCount > 0}
          <DashboardSection title="Needs Attention" count={attentionCount}>
            {#each attentionItems.planItems as item (item.planUuid)}
              <NeedsAttentionCard
                {item}
                {projectId}
                projectName={showProject ? projectNamesById[item.projectId] : undefined}
                selected={selectedPlanUuid === item.planUuid}
              />
            {/each}
            {#if attentionItems.sessionItems.length > 0}
              {#if attentionItems.planItems.length > 0}
                <div class="my-1 border-t border-border/50"></div>
              {/if}
              <p class="px-1 text-xs text-muted-foreground">Notifications</p>
              {#each attentionItems.sessionItems as session (session.connectionId)}
                <RunningNowRow
                  {session}
                  {projectId}
                  hasNotification={true}
                  projectName={showProject && session.projectId
                    ? projectNamesById[session.projectId]
                    : undefined}
                />
              {/each}
            {/if}
            {#if attentionItems.prItems.length > 0}
              {#if attentionItems.planItems.length > 0 || attentionItems.sessionItems.length > 0}
                <div class="my-1 border-t border-border/50"></div>
              {/if}
              <p class="px-1 text-xs text-muted-foreground">Pull Requests</p>
              {#each attentionItems.prItems as item (item.actionablePr.prUrl)}
                <PrAttentionCard
                  {item}
                  projectName={showProject
                    ? projectNamesById[item.actionablePr.projectId]
                    : undefined}
                  selected={selectedPrNumber === item.actionablePr.prNumber}
                />
              {/each}
            {/if}
          </DashboardSection>
        {/if}

        {#if runningSessions.length > 0}
          <DashboardSection title="Running Now" count={runningSessions.length}>
            {#each runningSessions as session (session.connectionId)}
              <RunningNowRow
                {session}
                {projectId}
                projectName={showProject && session.projectId
                  ? projectNamesById[session.projectId]
                  : undefined}
              />
            {/each}
          </DashboardSection>
        {/if}

        {#if readyPlans.length > 0}
          <DashboardSection title="Ready to Start" count={readyPlans.length}>
            {#each readyPlans as plan (plan.uuid)}
              <ReadyToStartRow
                {plan}
                {projectId}
                projectName={showProject ? projectNamesById[plan.projectId] : undefined}
                selected={selectedPlanUuid === plan.uuid}
              />
            {/each}
          </DashboardSection>
        {/if}

        {#if !sessionManager.initialized}
          <p class="py-2 text-center text-xs text-muted-foreground">Connecting to sessions...</p>
        {/if}
      {/if}
    </div>
  </div>

  <div class="min-w-0 flex-1 overflow-y-auto">
    {@render children()}
  </div>
</div>
