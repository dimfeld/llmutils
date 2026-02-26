import SwiftUI

// MARK: - PlanSortOrder

enum PlanSortOrder: String, CaseIterable, Identifiable {
    case planNumber
    case priority
    case recentlyUpdated
    case status

    var id: String {
        self.rawValue
    }

    var label: String {
        switch self {
        case .planNumber: "Plan Number"
        case .priority: "Priority"
        case .recentlyUpdated: "Recently Updated"
        case .status: "Status"
        }
    }

    /// Numeric rank for priority strings. Lower value = higher priority.
    private static func priorityRank(_ priority: String?) -> Int {
        switch priority?.lowercased() {
        case "urgent": 0
        case "high": 1
        case "medium": 2
        case "low": 3
        case "maybe": 4
        default: 5
        }
    }

    /// Numeric rank for display status. Groups active statuses first.
    private static func statusRank(_ status: PlanDisplayStatus) -> Int {
        switch status {
        case .inProgress: 0
        case .blocked: 1
        case .pending: 2
        case .recentlyDone: 3
        case .deferred: 4
        case .done: 5
        case .cancelled: 6
        }
    }

    func sorted(_ plans: [TrackedPlan], dependencyStatus: [String: Bool], now: Date) -> [TrackedPlan] {
        switch self {
        case .planNumber:
            // Default: matches DB ORDER BY plan_id DESC, updated_at DESC
            plans.sorted {
                let id0 = $0.planId ?? 0
                let id1 = $1.planId ?? 0
                if id0 != id1 { return id0 > id1 }
                let t0 = $0.updatedAt ?? .distantPast
                let t1 = $1.updatedAt ?? .distantPast
                if t0 != t1 { return t0 > t1 }
                return $0.uuid < $1.uuid
            }
        case .priority:
            plans.sorted {
                let r0 = Self.priorityRank($0.priority)
                let r1 = Self.priorityRank($1.priority)
                if r0 != r1 { return r0 < r1 }
                return ($0.planId ?? 0) > ($1.planId ?? 0)
            }
        case .recentlyUpdated:
            plans.sorted {
                let t0 = $0.updatedAt ?? .distantPast
                let t1 = $1.updatedAt ?? .distantPast
                if t0 != t1 { return t0 > t1 }
                return ($0.planId ?? 0) > ($1.planId ?? 0)
            }
        case .status:
            plans.sorted {
                let s0 = Self.statusRank(planDisplayStatus(
                    for: $0, hasUnresolvedDependencies: dependencyStatus[$0.uuid] ?? false, now: now))
                let s1 = Self.statusRank(planDisplayStatus(
                    for: $1, hasUnresolvedDependencies: dependencyStatus[$1.uuid] ?? false, now: now))
                if s0 != s1 { return s0 < s1 }
                return ($0.planId ?? 0) > ($1.planId ?? 0)
            }
        }
    }
}

// MARK: - PlansView

struct PlansView: View {
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
                    PlansSplitView(store: self.store)
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
                    PlansSplitView(store: self.store)
                }
            }
        }
        .onAppear { self.store.startRefreshing() }
        .onDisappear { self.store.stopRefreshing() }
    }
}

// MARK: - Search Filter

/// Filters plans by a search query, matching against title and goal (case-insensitive).
/// A whitespace-only or empty query returns the original array unchanged.
func filterPlansBySearchText(_ plans: [TrackedPlan], query: String) -> [TrackedPlan] {
    let trimmed = query.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return plans }
    return plans.filter { plan in
        (plan.title ?? "").localizedCaseInsensitiveContains(trimmed)
            || (plan.goal ?? "").localizedCaseInsensitiveContains(trimmed)
    }
}

// MARK: - PlansSplitView

private struct PlansSplitView: View {
    let store: ProjectTrackingStore
    @State private var selectedPlanUuid: String?

    var body: some View {
        NavigationSplitView {
            ProjectListView(store: self.store)
                .navigationSplitViewColumnWidth(min: 180, ideal: 240, max: 360)
                .background(.ultraThinMaterial)
        } content: {
            if self.store.selectedProjectId != nil {
                PlansBrowserView(
                    store: self.store,
                    selectedPlanUuid: self.$selectedPlanUuid)
                    .background(.thinMaterial)
            } else {
                ProjectsEmptyStateView(
                    icon: "doc.text.magnifyingglass",
                    iconColor: .secondary,
                    title: "No Project Selected",
                    subtitle: "Select a project from the sidebar to browse its plans.")
                    .background(.thinMaterial)
            }
        } detail: {
            if let uuid = self.selectedPlanUuid,
               let plan = self.store.plans.first(where: { $0.uuid == uuid })
            {
                PlanDetailView(plan: plan, store: self.store)
                    .id(uuid)
                    .background(.thinMaterial)
            } else {
                ProjectsEmptyStateView(
                    icon: "doc.text",
                    iconColor: .secondary,
                    title: "No Plan Selected",
                    subtitle: "Select a plan to view its details.")
                    .background(.thinMaterial)
            }
        }
        .onChange(of: self.store.selectedProjectId) {
            self.selectedPlanUuid = nil
        }
    }
}

// MARK: - PlansBrowserView

private struct PlansBrowserView: View {
    let store: ProjectTrackingStore
    @Binding var selectedPlanUuid: String?
    @State private var searchText: String = ""
    @State private var sortOrder: PlanSortOrder = .planNumber

    var body: some View {
        let now = Date()
        let statusFiltered = self.store.filteredPlans(now: now)
        let searched = self.applySearch(statusFiltered)
        let sorted = self.sortOrder.sorted(searched, dependencyStatus: self.store.planDependencyStatus, now: now)

        VStack(spacing: 0) {
            FilterChipsView(store: self.store)
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 8)

            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                    TextField("Search plans…", text: self.$searchText)
                        .textFieldStyle(.plain)
                        .font(.subheadline)
                    if !self.searchText.isEmpty {
                        Button {
                            self.searchText = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                                .font(.caption)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: nestedRectangleCornerRadius))

                Picker("Sort", selection: self.$sortOrder) {
                    ForEach(PlanSortOrder.allCases) { order in
                        Text(order.label).tag(order)
                    }
                }
                .pickerStyle(.menu)
                .fixedSize()
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)

            if sorted.isEmpty {
                Spacer()
                VStack(spacing: 10) {
                    Image(systemName: "doc.text.magnifyingglass")
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text(
                        self.searchText.isEmpty
                            ? "No plans match the current filters"
                            : "No plans match the current filters and search")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 6) {
                        ForEach(sorted) { plan in
                            PlanRowView(
                                plan: plan,
                                displayStatus: self.store.displayStatus(for: plan, now: now),
                                isSelected: plan.uuid == self.selectedPlanUuid,
                                now: now)
                                .onTapGesture {
                                    self.selectedPlanUuid = plan.uuid
                                }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                }
            }
        }
        .id(self.store.selectedProjectId)
        .onChange(of: sorted.map(\.uuid)) { _, visibleUuids in
            if let selected = self.selectedPlanUuid, !visibleUuids.contains(selected) {
                self.selectedPlanUuid = nil
            }
        }
    }

    private func applySearch(_ plans: [TrackedPlan]) -> [TrackedPlan] {
        filterPlansBySearchText(plans, query: self.searchText)
    }
}

// MARK: - PlanDetailView

@MainActor let planAbsoluteDateFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateStyle = .medium
    f.timeStyle = .short
    return f
}()

struct PlanDetailView: View {
    let plan: TrackedPlan
    let store: ProjectTrackingStore

    var body: some View {
        let now = Date()
        let displayStatus = self.store.displayStatus(for: self.plan, now: now)
        let hasUnresolvedDeps = self.store.planDependencyStatus[self.plan.uuid] ?? false
        let assignedWorkspace = self.store.workspaces.first { $0.planId == self.plan.planId && self.plan.planId != nil }

        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Header: plan number + title
                VStack(alignment: .leading, spacing: 6) {
                    if let planId = plan.planId {
                        Text("#\(planId)")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    Text(self.plan.displayTitle)
                        .font(.title2.weight(.bold))
                        .textSelection(.enabled)
                }

                // Goal
                if let goal = plan.goal, !goal.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Goal")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(goal)
                            .font(.body)
                            .textSelection(.enabled)
                    }
                }

                Divider()

                // Metadata grid
                VStack(alignment: .leading, spacing: 12) {
                    PlanDetailRow(label: "Status") {
                        HStack(spacing: 6) {
                            Image(systemName: self.statusIcon(for: displayStatus))
                                .foregroundStyle(self.statusColor(for: displayStatus))
                                .font(.callout)
                            Text(displayStatus.label)
                                .foregroundStyle(self.statusColor(for: displayStatus))
                        }
                    }

                    if let priority = plan.priority, !priority.isEmpty {
                        PlanDetailRow(label: "Priority") {
                            Text(priority.capitalized)
                        }
                    }

                    if hasUnresolvedDeps {
                        PlanDetailRow(label: "Dependencies") {
                            HStack(spacing: 4) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(.orange)
                                    .font(.caption)
                                Text("Has unresolved dependencies")
                                    .foregroundStyle(.orange)
                            }
                        }
                    }

                    PlanDetailRow(label: "Workspace") {
                        if let workspace = assignedWorkspace {
                            Text(workspace.displayName)
                        } else {
                            Text("Unassigned")
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let branch = plan.branch, !branch.isEmpty {
                        PlanDetailRow(label: "Branch") {
                            Text(branch)
                                .font(.callout.monospaced())
                        }
                    }

                    if self.plan.isEpic {
                        PlanDetailRow(label: "Type") {
                            HStack(spacing: 4) {
                                Image(systemName: "star.fill")
                                    .foregroundStyle(.yellow)
                                    .font(.caption)
                                Text("Epic")
                            }
                        }
                    }

                    if let parentUuid = plan.parentUuid, !parentUuid.isEmpty {
                        PlanDetailRow(label: "Parent") {
                            Text(parentUuid)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .textSelection(.enabled)
                        }
                    }

                    if let filename = plan.filename, !filename.isEmpty {
                        PlanDetailRow(label: "File") {
                            Text(filename)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }

                    Divider()

                    if let createdAt = plan.createdAt {
                        PlanDetailRow(label: "Created") {
                            Text(planAbsoluteDateFormatter.string(from: createdAt))
                                .foregroundStyle(.secondary)
                        }
                    }

                    if let updatedAt = plan.updatedAt {
                        PlanDetailRow(label: "Updated") {
                            HStack(spacing: 8) {
                                Text(planAbsoluteDateFormatter.string(from: updatedAt))
                                    .foregroundStyle(.secondary)
                                Text("(\(planRelativeDateFormatter.localizedString(for: updatedAt, relativeTo: now)))")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
            .padding(20)
        }
    }

    private func statusIcon(for status: PlanDisplayStatus) -> String {
        switch status {
        case .pending: "circle"
        case .inProgress: "play.circle.fill"
        case .blocked: "exclamationmark.circle.fill"
        case .recentlyDone: "checkmark.circle.fill"
        case .done: "checkmark.circle"
        case .cancelled: "xmark.circle"
        case .deferred: "clock.arrow.circlepath"
        }
    }

    private func statusColor(for status: PlanDisplayStatus) -> Color {
        switch status {
        case .pending: .secondary
        case .inProgress: .blue
        case .blocked: .orange
        case .recentlyDone: .green
        case .done: .gray
        case .cancelled: .red
        case .deferred: .purple
        }
    }
}

// MARK: - PlanDetailRow

private struct PlanDetailRow<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(self.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 90, alignment: .trailing)
            self.content
                .font(.callout)
            Spacer()
        }
    }
}

// MARK: - FilterChipsView

private struct FilterChipsView: View {
    let store: ProjectTrackingStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Filter")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                Spacer()

                Button {
                    self.store.activeFilters = defaultPlanFilters()
                } label: {
                    Text("Reset")
                        .font(.caption2.weight(.medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(
                    self.store.activeFilters == defaultPlanFilters()
                        ? Color.secondary : Color.accentColor)
                .disabled(self.store.activeFilters == defaultPlanFilters())

                Button {
                    self.store.activeFilters = Set(PlanDisplayStatus.allCases)
                } label: {
                    Text("All")
                        .font(.caption2.weight(.medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(
                    self.store.activeFilters == Set(PlanDisplayStatus.allCases)
                        ? Color.secondary : Color.accentColor)
                .disabled(self.store.activeFilters == Set(PlanDisplayStatus.allCases))
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(PlanDisplayStatus.allCases, id: \.self) { status in
                        FilterChip(
                            label: status.label,
                            isActive: self.store.activeFilters.contains(status),
                            color: self.chipColor(for: status))
                        {
                            if self.store.activeFilters.contains(status) {
                                self.store.activeFilters.remove(status)
                            } else {
                                self.store.activeFilters.insert(status)
                            }
                        }
                    }
                }
            }
        }
    }

    private func chipColor(for status: PlanDisplayStatus) -> Color {
        switch status {
        case .pending: .secondary
        case .inProgress: .blue
        case .blocked: .orange
        case .recentlyDone: .green
        case .done: .gray
        case .cancelled: .red
        case .deferred: .purple
        }
    }
}

// MARK: - FilterChip

private struct FilterChip: View {
    let label: String
    let isActive: Bool
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            Text(self.label)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    RoundedRectangle(cornerRadius: nestedRectangleCornerRadius)
                        .fill(self.isActive
                            ? AnyShapeStyle(self.color.opacity(0.18))
                            : AnyShapeStyle(.quaternary.opacity(0.08))))
                .overlay(
                    RoundedRectangle(cornerRadius: nestedRectangleCornerRadius)
                        .stroke(
                            self.isActive ? self.color.opacity(0.45) : Color.clear,
                            lineWidth: 1))
                .foregroundStyle(self.isActive ? self.color : .secondary)
        }
        .buttonStyle(.plain)
    }
}
