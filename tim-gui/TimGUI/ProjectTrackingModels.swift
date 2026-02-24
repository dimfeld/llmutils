import Foundation

// MARK: - TrackedProject

struct TrackedProject: Identifiable, Equatable, Sendable {
    let id: String
    let repositoryId: String?
    let remoteUrl: String?
    let lastGitRoot: String?
    let remoteLabel: String?

    var displayName: String {
        if let label = remoteLabel, !label.isEmpty { return label }
        if let root = lastGitRoot, !root.isEmpty {
            let components = root.split(separator: "/", omittingEmptySubsequences: true)
            return components.last.map(String.init) ?? root
        }
        if let url = remoteUrl, !url.isEmpty {
            let components = url.split(separator: "/", omittingEmptySubsequences: true)
            return components.last.map(String.init) ?? url
        }
        return self.id
    }
}

// MARK: - WorkspaceDisplayStatus

enum WorkspaceDisplayStatus: Sendable {
    case available
    case locked
    case primary
}

// MARK: - TrackedWorkspace

struct TrackedWorkspace: Identifiable, Equatable, Sendable {
    let id: String
    let projectId: String
    let workspacePath: String?
    let branch: String?
    let name: String?
    let description: String?
    let planId: Int?
    let planTitle: String?
    let isPrimary: Bool
    let isLocked: Bool

    var displayStatus: WorkspaceDisplayStatus {
        if self.isLocked { return .locked }
        if self.isPrimary { return .primary }
        return .available
    }

    var displayName: String {
        if let name, !name.isEmpty { return name }
        if let path = workspacePath, !path.isEmpty {
            let components = path.split(separator: "/", omittingEmptySubsequences: true)
            return components.suffix(2).joined(separator: "/")
        }
        return self.id
    }
}

// MARK: - TrackedPlan

struct TrackedPlan: Identifiable, Equatable, Sendable {
    let uuid: String
    let projectId: String
    let planId: Int?
    let title: String?
    let goal: String?
    /// Raw status string from DB: pending, in_progress, done, cancelled, deferred
    let status: String
    let priority: String?
    let parentUuid: String?
    let isEpic: Bool
    let filename: String?
    let createdAt: Date?
    let updatedAt: Date?
    let branch: String?

    var id: String {
        self.uuid
    }

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        if let planId { return "Plan \(planId)" }
        return self.uuid
    }
}

// MARK: - PlanDisplayStatus

enum PlanDisplayStatus: String, CaseIterable, Hashable, Sendable {
    case pending
    case inProgress
    case blocked
    case recentlyDone
    case done
    case cancelled
    case deferred

    var label: String {
        switch self {
        case .pending: "Pending"
        case .inProgress: "In Progress"
        case .blocked: "Blocked"
        case .recentlyDone: "Recently Done"
        case .done: "Done"
        case .cancelled: "Cancelled"
        case .deferred: "Deferred"
        }
    }
}

// MARK: - Filter Logic

/// Derives the display status for a plan given its DB status, dependency information, and current time.
///
/// Mapping rules:
/// - `pending` → `.pending` (or `.blocked` if it has unresolved dependencies)
/// - `in_progress` → `.inProgress`
/// - `done` + updated within 7 days → `.recentlyDone`
/// - `done` + updated more than 7 days ago → `.done`
/// - `cancelled` → `.cancelled`
/// - `deferred` → `.deferred`
func planDisplayStatus(
    for plan: TrackedPlan,
    hasUnresolvedDependencies: Bool,
    now: Date) -> PlanDisplayStatus
{
    switch plan.status {
    case "pending":
        return hasUnresolvedDependencies ? .blocked : .pending
    case "in_progress":
        return .inProgress
    case "done":
        let sevenDaysAgo = now.addingTimeInterval(-7 * 24 * 60 * 60)
        if let updatedAt = plan.updatedAt, updatedAt >= sevenDaysAgo {
            return .recentlyDone
        }
        return .done
    case "cancelled":
        return .cancelled
    case "deferred":
        return .deferred
    default:
        return .pending
    }
}

/// Returns the default set of active plan status filters (pending, in-progress, blocked, recently done).
func defaultPlanFilters() -> Set<PlanDisplayStatus> {
    [.pending, .inProgress, .blocked, .recentlyDone]
}

/// Returns true if the plan should be shown given its display status and the active filter set.
func shouldShowPlan(displayStatus: PlanDisplayStatus, activeFilters: Set<PlanDisplayStatus>) -> Bool {
    activeFilters.contains(displayStatus)
}
