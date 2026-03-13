import SwiftUI

// MARK: - PlanSortOrder

enum PlanSortOrder: String, CaseIterable, Identifiable {
    case planNumber
    case priority
    case recentlyUpdated

    var id: String {
        self.rawValue
    }

    var label: String {
        switch self {
        case .planNumber: "Plan Number"
        case .priority: "Priority"
        case .recentlyUpdated: "Recently Updated"
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
        }
    }

    func sorted(_ rows: [PlanRowDisplayModel]) -> [PlanRowDisplayModel] {
        switch self {
        case .planNumber:
            rows.sorted {
                let id0 = $0.plan.planId ?? 0
                let id1 = $1.plan.planId ?? 0
                if id0 != id1 { return id0 > id1 }
                let t0 = $0.plan.updatedAt ?? .distantPast
                let t1 = $1.plan.updatedAt ?? .distantPast
                if t0 != t1 { return t0 > t1 }
                return $0.plan.uuid < $1.plan.uuid
            }
        case .priority:
            rows.sorted {
                let r0 = Self.priorityRank($0.plan.priority)
                let r1 = Self.priorityRank($1.plan.priority)
                if r0 != r1 { return r0 < r1 }
                return ($0.plan.planId ?? 0) > ($1.plan.planId ?? 0)
            }
        case .recentlyUpdated:
            rows.sorted {
                let t0 = $0.plan.updatedAt ?? .distantPast
                let t1 = $1.plan.updatedAt ?? .distantPast
                if t0 != t1 { return t0 > t1 }
                return ($0.plan.planId ?? 0) > ($1.plan.planId ?? 0)
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

// MARK: - Plan Status Grouping

struct PlanStatusGroup: Identifiable {
    let status: PlanDisplayStatus
    let plans: [TrackedPlan]
    var id: PlanDisplayStatus {
        self.status
    }
}

struct PlanRowDisplayModel: Identifiable, Equatable {
    let plan: TrackedPlan
    let displayStatus: PlanDisplayStatus
    let relativeUpdatedText: String?

    var id: String {
        self.plan.uuid
    }
}

struct PlanStatusGroupDisplayModel: Identifiable, Equatable {
    let status: PlanDisplayStatus
    let plans: [PlanRowDisplayModel]

    var id: PlanDisplayStatus {
        self.status
    }
}

struct PlansBrowserDerivedData: Equatable {
    let groups: [PlanStatusGroupDisplayModel]
    let visiblePlanUuids: [String]

    static let empty = PlansBrowserDerivedData(groups: [], visiblePlanUuids: [])
}

/// Collects the UUIDs of all plans across groups, preserving group and within-group order.
/// Used by the deselection logic to detect when a selected plan is no longer visible.
func visiblePlanUuids(from groups: [PlanStatusGroup]) -> [String] {
    groups.flatMap { $0.plans.map(\.uuid) }
}

func buildPlansBrowserDerivedData(
    plans: [TrackedPlan],
    dependencyStatus: [String: Bool],
    activeFilters: Set<PlanDisplayStatus>,
    searchText: String,
    sortOrder: PlanSortOrder,
    now: Date) -> PlansBrowserDerivedData
{
    let relativeDateFormatter = RelativeDateTimeFormatter()
    relativeDateFormatter.unitsStyle = .short

    let filtered = plans.compactMap { plan -> PlanRowDisplayModel? in
        let hasUnresolved = dependencyStatus[plan.uuid] ?? false
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: hasUnresolved, now: now)
        guard shouldShowPlan(displayStatus: status, activeFilters: activeFilters) else {
            return nil
        }
        return PlanRowDisplayModel(
            plan: plan,
            displayStatus: status,
            relativeUpdatedText: plan.updatedAt.map {
                relativeDateFormatter.localizedString(for: $0, relativeTo: now)
            })
    }

    let searched = filterPlansBySearchText(filtered.map(\.plan), query: searchText)
    let searchedIds = Set(searched.map(\.uuid))
    let sorted = sortOrder.sorted(filtered.filter { searchedIds.contains($0.plan.uuid) })

    var grouped: [PlanDisplayStatus: [PlanRowDisplayModel]] = [:]
    for row in sorted {
        grouped[row.displayStatus, default: []].append(row)
    }

    let groups: [PlanStatusGroupDisplayModel] = planStatusGroupOrder.compactMap { status in
        guard let rows = grouped[status], !rows.isEmpty else { return nil }
        return PlanStatusGroupDisplayModel(status: status, plans: rows)
    }

    return PlansBrowserDerivedData(
        groups: groups,
        visiblePlanUuids: groups.flatMap { group in group.plans.map { $0.id } })
}

/// The default sort order for the plans browser (used when grouping makes status sort redundant).
let planBrowserDefaultSortOrder: PlanSortOrder = .recentlyUpdated

/// The display order for plan status groups, from most to least actionable.
let planStatusGroupOrder: [PlanDisplayStatus] = [
    .inProgress, .pending, .blocked, .recentlyDone, .done, .deferred, .cancelled,
]

/// Groups pre-sorted plans by their display status, returning groups in a fixed order.
/// Empty groups are excluded. Within-group order from the input array is preserved.
func groupPlansByStatus(
    _ plans: [TrackedPlan],
    dependencyStatus: [String: Bool],
    now: Date) -> [PlanStatusGroup]
{
    var grouped: [PlanDisplayStatus: [TrackedPlan]] = [:]
    for plan in plans {
        let hasUnresolved = dependencyStatus[plan.uuid] ?? false
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: hasUnresolved, now: now)
        grouped[status, default: []].append(plan)
    }

    return planStatusGroupOrder.compactMap { status in
        guard let plans = grouped[status], !plans.isEmpty else { return nil }
        return PlanStatusGroup(status: status, plans: plans)
    }
}

// MARK: - PlanGroupHeaderView

private struct PlanGroupHeaderView: View {
    let status: PlanDisplayStatus
    let count: Int
    let isCollapsed: Bool
    let onToggle: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .rotationEffect(.degrees(self.isCollapsed ? 0 : 90))
                .animation(.easeInOut(duration: 0.2), value: self.isCollapsed)

            Image(systemName: self.status.icon)
                .font(.caption)
                .foregroundStyle(self.status.color)

            Text(self.status.label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(self.status.color)

            Spacer()

            Text("\(self.count)")
                .font(.caption2)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.quaternary, in: Capsule())
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .onTapGesture(perform: self.onToggle)
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
    @State private var sortOrder: PlanSortOrder = planBrowserDefaultSortOrder
    @State private var collapsedGroups: Set<PlanDisplayStatus> = []
    @State private var derivedData = PlansBrowserDerivedData.empty

    private var searchControls: some View {
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
            .background(
                .quaternary.opacity(0.5),
                in: RoundedRectangle(cornerRadius: nestedRectangleCornerRadius))

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
    }

    private var plansContent: some View {
        Group {
            if self.derivedData.groups.isEmpty {
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
                        ForEach(self.derivedData.groups) { group in
                            let isCollapsed = self.collapsedGroups.contains(group.status)
                            Section {
                                if !isCollapsed {
                                    ForEach(group.plans) { plan in
                                        PlanRowView(
                                            plan: plan.plan,
                                            displayStatus: group.status,
                                            relativeUpdatedText: plan.relativeUpdatedText,
                                            isSelected: plan.id == self.selectedPlanUuid)
                                            .equatable()
                                            .onTapGesture {
                                                self.selectedPlanUuid = plan.id
                                            }
                                    }
                                }
                            } header: {
                                PlanGroupHeaderView(
                                    status: group.status,
                                    count: group.plans.count,
                                    isCollapsed: isCollapsed)
                                {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        if isCollapsed {
                                            self.collapsedGroups.remove(group.status)
                                        } else {
                                            self.collapsedGroups.insert(group.status)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                }
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            FilterChipsView(store: self.store)
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 8)
            self.searchControls
            self.plansContent
        }
        .id(self.store.selectedProjectId)
        .onAppear {
            self.recomputeDerivedData()
        }
        .onChange(of: self.store.plans) {
            self.recomputeDerivedData()
        }
        .onChange(of: self.store.planDependencyStatus) {
            self.recomputeDerivedData()
        }
        .onChange(of: self.store.activeFilters) {
            self.recomputeDerivedData()
        }
        .onChange(of: self.searchText) {
            self.recomputeDerivedData()
        }
        .onChange(of: self.sortOrder) {
            self.recomputeDerivedData()
        }
    }

    private func recomputeDerivedData() {
        let derived = buildPlansBrowserDerivedData(
            plans: self.store.plans,
            dependencyStatus: self.store.planDependencyStatus,
            activeFilters: self.store.activeFilters,
            searchText: self.searchText,
            sortOrder: self.sortOrder,
            now: Date())
        self.derivedData = derived
        if let selected = self.selectedPlanUuid, !derived.visiblePlanUuids.contains(selected) {
            self.selectedPlanUuid = nil
        }
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
                            Image(systemName: displayStatus.icon)
                                .foregroundStyle(displayStatus.color)
                                .font(.callout)
                            Text(displayStatus.label)
                                .foregroundStyle(displayStatus.color)
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
                            color: status.color)
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
