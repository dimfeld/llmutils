import SwiftUI

// MARK: - ProjectsView

struct ProjectsView: View {
    @Bindable var store: ProjectTrackingStore

    var body: some View {
        Group {
            switch self.store.loadState {
            case let .error(message):
                ProjectsEmptyStateView(
                    icon: "exclamationmark.triangle",
                    iconColor: .red,
                    title: "Failed to Load Projects",
                    subtitle: message)
                    .background(.thinMaterial)
            case .idle, .loading:
                if self.store.projects.isEmpty {
                    ProjectsLoadingView()
                        .background(.thinMaterial)
                } else {
                    ProjectsSplitView(store: self.store)
                }
            case .loaded:
                if self.store.projects.isEmpty {
                    ProjectsEmptyStateView(
                        icon: "folder",
                        iconColor: .secondary,
                        title: "No Projects",
                        subtitle: "No projects found in tim database.")
                        .background(.thinMaterial)
                } else {
                    ProjectsSplitView(store: self.store)
                }
            }
        }
        .onAppear { self.store.startRefreshing() }
        .onDisappear { self.store.stopRefreshing() }
    }
}

// MARK: - ProjectsLoadingView

private struct ProjectsLoadingView: View {
    var body: some View {
        VStack(spacing: 14) {
            ProgressView()
                .scaleEffect(1.2)
            Text("Loading projects...")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - ProjectsEmptyStateView

private struct ProjectsEmptyStateView: View {
    let icon: String
    let iconColor: Color
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(.quaternary.opacity(0.25))
                    .frame(width: 56, height: 56)
                Image(systemName: self.icon)
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(self.iconColor)
            }
            VStack(spacing: 4) {
                Text(self.title)
                    .font(.title3.weight(.semibold))
                Text(self.subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
    }
}

// MARK: - ProjectsSplitView

private struct ProjectsSplitView: View {
    let store: ProjectTrackingStore

    var body: some View {
        NavigationSplitView {
            ProjectListView(store: self.store)
                .navigationSplitViewColumnWidth(min: 180, ideal: 240, max: 360)
                .background(.ultraThinMaterial)
        } detail: {
            if self.store.selectedProjectId != nil {
                ProjectDetailView(store: self.store)
                    .background(.thinMaterial)
            } else {
                ProjectsEmptyStateView(
                    icon: "folder.badge.questionmark",
                    iconColor: .secondary,
                    title: "No Project Selected",
                    subtitle: "Select a project from the sidebar to view its workspaces and plans.")
                    .background(.thinMaterial)
            }
        }
    }
}

// MARK: - ProjectListView

private struct ProjectListView: View {
    let store: ProjectTrackingStore

    var body: some View {
        List(self.store.projects) { project in
            ProjectRowView(
                project: project,
                isSelected: project.id == self.store.selectedProjectId)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 3, leading: 12, bottom: 3, trailing: 12))
                .onTapGesture { self.store.selectProject(id: project.id) }
        }
        .listStyle(.sidebar)
    }
}

// MARK: - ProjectRowView

private struct ProjectRowView: View {
    let project: TrackedProject
    let isSelected: Bool

    private var rowBackgroundStyle: AnyShapeStyle {
        self.isSelected
            ? AnyShapeStyle(Color.accentColor.opacity(0.18))
            : AnyShapeStyle(.quaternary.opacity(0.08))
    }

    private var rowBorderStyle: AnyShapeStyle {
        self.isSelected
            ? AnyShapeStyle(Color.accentColor.opacity(0.45))
            : AnyShapeStyle(Color.clear)
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "folder")
                .font(.callout)
                .foregroundStyle(self.isSelected ? Color.accentColor : Color.secondary)

            VStack(alignment: .leading, spacing: 2) {
                Text(self.project.displayName)
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)

                if let root = self.project.lastGitRoot, !root.isEmpty {
                    let components = root.split(separator: "/", omittingEmptySubsequences: true)
                    let displayPath = components.suffix(2).joined(separator: "/")
                    Text(displayPath)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: nestedRectangleCornerRadius)
                .fill(self.rowBackgroundStyle))
        .overlay(
            RoundedRectangle(cornerRadius: nestedRectangleCornerRadius)
                .stroke(self.rowBorderStyle, lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: nestedRectangleCornerRadius))
    }
}

// MARK: - ProjectDetailView

private struct ProjectDetailView: View {
    let store: ProjectTrackingStore

    var body: some View {
        let now = Date()
        let hasWorkspaces = !self.store.workspaces.isEmpty
        let activePlans = self.store.plans.filter { plan in
            self.store.displayStatus(for: plan, now: now).isActiveWork
        }

        if !hasWorkspaces, activePlans.isEmpty {
            ProjectsEmptyStateView(
                icon: "tray",
                iconColor: .secondary,
                title: "No Active Work",
                subtitle: "No active work — browse all plans to get started")
                .background(.thinMaterial)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    WorkspacesSection(workspaces: self.store.workspaces)
                    Divider()
                    PlansSection(store: self.store, activePlans: activePlans)
                }
                .padding(16)
            }
        }
    }
}

// MARK: - WorkspacesSection

private struct WorkspacesSection: View {
    let workspaces: [TrackedWorkspace]
    @State private var showAllWorkspaces: Bool = false

    var body: some View {
        let now = Date()
        let activeWorkspaces = self.workspaces.filter { $0.isRecentlyActive(now: now) }
        let displayedWorkspaces = self.showAllWorkspaces ? self.workspaces : activeWorkspaces
        let hiddenCount = self.workspaces.count - activeWorkspaces.count

        VStack(alignment: .leading, spacing: 8) {
            Text("Workspaces")
                .font(.headline)
                .foregroundStyle(.secondary)

            if self.workspaces.isEmpty {
                Text("No workspaces")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
                    .padding(.vertical, 4)
            } else if activeWorkspaces.isEmpty, !self.showAllWorkspaces {
                Text("No recently active workspaces")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
                    .padding(.vertical, 4)
            } else {
                ForEach(displayedWorkspaces) { workspace in
                    WorkspaceRowView(workspace: workspace)
                }
            }

            if hiddenCount > 0 {
                Button {
                    self.showAllWorkspaces.toggle()
                } label: {
                    Text(self.showAllWorkspaces
                         ? "Show active only"
                         : "Show all workspaces (\(self.workspaces.count) total)")
                        .font(.caption)
                        .foregroundStyle(.blue)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - WorkspaceRowView

private struct WorkspaceRowView: View {
    let workspace: TrackedWorkspace

    private var statusIcon: String? {
        switch self.workspace.displayStatus {
        case .primary: "star.fill"
        case .locked: "lock.fill"
        case .available: nil
        }
    }

    private var statusColor: Color {
        switch self.workspace.displayStatus {
        case .primary: .yellow
        case .locked: .orange
        case .available: .secondary
        }
    }

    private var statusLabel: String? {
        switch self.workspace.displayStatus {
        case .primary: "Primary"
        case .locked: "Locked"
        case .available: nil
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            Group {
                if let statusIcon {
                    Image(systemName: statusIcon)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(self.statusColor)
                }
            }
            .frame(width: 14)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(self.workspace.displayName)
                        .font(.callout.weight(.semibold))
                        .lineLimit(1)

                    if let branch = self.workspace.branch, !branch.isEmpty {
                        Text(branch)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(
                                .quaternary.opacity(0.5),
                                in: RoundedRectangle(cornerRadius: 4))
                    }
                }

                if self.workspace.planId != nil || (self.workspace.planTitle != nil && !self.workspace.planTitle!.isEmpty) {
                    HStack(spacing: 4) {
                        if let planId = self.workspace.planId {
                            Text("#\(planId)")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                        if let planTitle = self.workspace.planTitle, !planTitle.isEmpty {
                            Text(planTitle)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    .font(.caption)
                }
            }

            Spacer()

            if let statusLabel {
                Text(statusLabel)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(self.statusColor)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            .quaternary.opacity(0.08),
            in: RoundedRectangle(cornerRadius: nestedRectangleCornerRadius))
    }
}

// MARK: - PlansSection

private struct PlansSection: View {
    let store: ProjectTrackingStore
    let activePlans: [TrackedPlan]

    var body: some View {
        let now = Date()

        VStack(alignment: .leading, spacing: 8) {
            Text("Plans")
                .font(.headline)
                .foregroundStyle(.secondary)

            if self.activePlans.isEmpty {
                Text("No active plans — browse all plans to get started")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
                    .padding(.vertical, 4)
            } else {
                ForEach(self.activePlans) { plan in
                    PlanRowView(
                        plan: plan,
                        displayStatus: self.store.displayStatus(for: plan, now: now),
                        now: now)
                }
            }
        }
    }
}

// MARK: - PlanRowView

@MainActor private let planRelativeDateFormatter: RelativeDateTimeFormatter = {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .short
    return f
}()

private struct PlanRowView: View {
    let plan: TrackedPlan
    let displayStatus: PlanDisplayStatus
    let now: Date

    private var statusIcon: String {
        switch self.displayStatus {
        case .pending: "circle"
        case .inProgress: "play.circle.fill"
        case .blocked: "exclamationmark.circle.fill"
        case .recentlyDone: "checkmark.circle.fill"
        case .done: "checkmark.circle"
        case .cancelled: "xmark.circle"
        case .deferred: "clock.arrow.circlepath"
        }
    }

    private var statusColor: Color {
        switch self.displayStatus {
        case .pending: .secondary
        case .inProgress: .blue
        case .blocked: .orange
        case .recentlyDone: .green
        case .done: .gray
        case .cancelled: .red
        case .deferred: .purple
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: self.statusIcon)
                .font(.callout)
                .foregroundStyle(self.statusColor)
                .frame(width: 18)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if let planId = self.plan.planId {
                        Text("#\(planId)")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }

                    Text(self.plan.displayTitle)
                        .font(.callout.weight(.semibold))
                        .lineLimit(2)
                }

                if let goal = self.plan.goal, !goal.isEmpty {
                    Text(goal)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                HStack(spacing: 8) {
                    Text(self.displayStatus.label)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(self.statusColor)

                    if let updatedAt = self.plan.updatedAt {
                        Text(planRelativeDateFormatter.localizedString(for: updatedAt, relativeTo: self.now))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            .quaternary.opacity(0.08),
            in: RoundedRectangle(cornerRadius: nestedRectangleCornerRadius))
    }
}
