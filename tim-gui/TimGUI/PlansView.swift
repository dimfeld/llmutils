import SwiftUI

// MARK: - PlanSortOrder

enum PlanSortOrder: String, CaseIterable, Identifiable {
    case planNumber
    case priority
    case recentlyUpdated
    case status

    var id: String { self.rawValue }

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
        default: 4
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
            // Default: highest plan number first (matches DB ORDER BY plan_id DESC)
            plans.sorted { ($0.planId ?? 0) > ($1.planId ?? 0) }
        case .priority:
            plans.sorted { Self.priorityRank($0.priority) < Self.priorityRank($1.priority) }
        case .recentlyUpdated:
            plans.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
        case .status:
            plans.sorted {
                Self.statusRank(planDisplayStatus(
                    for: $0, hasUnresolvedDependencies: dependencyStatus[$0.uuid] ?? false, now: now))
                    < Self.statusRank(planDisplayStatus(
                        for: $1, hasUnresolvedDependencies: dependencyStatus[$1.uuid] ?? false, now: now))
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

    var body: some View {
        NavigationSplitView {
            ProjectListView(store: self.store)
                .navigationSplitViewColumnWidth(min: 180, ideal: 240, max: 360)
                .background(.ultraThinMaterial)
        } detail: {
            if self.store.selectedProjectId != nil {
                PlansBrowserView(store: self.store)
                    .background(.thinMaterial)
            } else {
                ProjectsEmptyStateView(
                    icon: "doc.text.magnifyingglass",
                    iconColor: .secondary,
                    title: "No Project Selected",
                    subtitle: "Select a project from the sidebar to browse its plans.")
                    .background(.thinMaterial)
            }
        }
    }
}

// MARK: - PlansBrowserView

private struct PlansBrowserView: View {
    let store: ProjectTrackingStore
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
                                now: now)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                }
            }
        }
        .id(self.store.selectedProjectId)
    }

    private func applySearch(_ plans: [TrackedPlan]) -> [TrackedPlan] {
        filterPlansBySearchText(plans, query: self.searchText)
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
