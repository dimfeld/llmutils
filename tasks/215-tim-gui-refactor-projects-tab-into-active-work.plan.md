---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: "tim-gui: Refactor Projects tab into Active Work dashboard"
goal: Transform the current Projects tab into a focused 'Active Work' dashboard
  that shows only in-progress plans and recently-used workspaces, providing a
  quick status overview of what's currently happening in each project
id: 215
uuid: 79f51dfc-c14b-4bd1-b129-324090af5a89
generatedBy: agent
status: in_progress
priority: medium
planGeneratedAt: 2026-02-25T08:32:07.431Z
promptsGeneratedAt: 2026-02-25T08:32:07.431Z
createdAt: 2026-02-25T08:31:24.257Z
updatedAt: 2026-02-26T07:42:48.791Z
tasks:
  - title: Rename Projects tab to Active Work in top navigation
    done: false
    description: In ContentView.swift, rename the "Projects" segment in the
      segmented picker to "Active" or "Active Work". Update the ViewSelection
      enum and any related labels. The tab should convey that this is a live
      status dashboard, not a full project browser.
  - title: Filter workspaces to show only recently active ones
    done: false
    description: In ProjectTrackingStore.swift, update the workspace fetch/filter
      logic to only show workspaces that are either currently locked, marked as
      primary, or have been used recently (e.g. within the last 24-48 hours
      based on assignment timestamps or lock activity). Add a toggle or link
      like "Show all workspaces" that expands to the full list if needed. This
      dramatically reduces the workspace section height in most cases.
  - title: Filter plans section to show only in-progress and blocked plans
    done: false
    description: Replace the current filter chips UI in PlansSection with a
      hardcoded filter showing only inProgress and blocked plans. Remove the
      FilterChipsView from this view (it will be reused in the dedicated Plans
      browser tab later). If there are no active plans, show an empty state like
      "No active plans — browse all plans to get started" with a link/action to
      navigate to the Plans tab (once it exists).
  - title: Remove redundant Available status badges from workspace rows
    done: false
    description: In WorkspaceRowView, stop showing the "Available" status
      text/badge. Only show status indicators for non-default states (Primary,
      Locked). The absence of a badge implies available. This reduces visual
      noise.
  - title: Visually link workspaces to their assigned plans
    done: false
    description: When a workspace has an assigned plan (via assignedPlanUuid), show
      the plan title or number inline on the workspace row. This connects the
      two sections and makes it immediately clear what each workspace is working
      on. Consider whether the workspace and plan sections should be merged into
      a single "active work" list when item counts are small.
  - title: Add empty state handling for the active work dashboard
    done: false
    description: Handle the case where a project has no in-progress plans and no
      recently active workspaces. Show a helpful empty state message that guides
      the user to the Plans tab to pick up work. Also handle the case where
      there are active plans but no workspaces, and vice versa.
tags:
  - tim-gui
---
