import SwiftUI

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

    var body: some View {
        let now = Date()
        let filtered = self.store.filteredPlans(now: now)

        VStack(spacing: 0) {
            FilterChipsView(store: self.store)
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 8)

            if filtered.isEmpty {
                Spacer()
                VStack(spacing: 10) {
                    Image(systemName: "doc.text.magnifyingglass")
                        .font(.system(size: 28, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text("No plans match the current filters")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 6) {
                        ForEach(filtered) { plan in
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
