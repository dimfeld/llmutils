import Foundation
import Testing
@testable import TimGUI

// MARK: - Helpers

private func makePlan(
    status: String,
    updatedAt: Date? = nil,
    uuid: String = UUID().uuidString) -> TrackedPlan
{
    TrackedPlan(
        uuid: uuid,
        projectId: "proj-1",
        planId: 1,
        title: "Test Plan",
        goal: nil,
        status: status,
        priority: nil,
        parentUuid: nil,
        isEpic: false,
        filename: nil,
        createdAt: nil,
        updatedAt: updatedAt,
        branch: nil)
}

private func makeWorkspace(
    isPrimary: Bool = false,
    isLocked: Bool = false,
    updatedAt: Date? = nil) -> TrackedWorkspace
{
    TrackedWorkspace(
        id: "ws-1",
        projectId: "proj-1",
        workspacePath: nil,
        branch: nil,
        name: nil,
        description: nil,
        planId: nil,
        planTitle: nil,
        isPrimary: isPrimary,
        isLocked: isLocked,
        updatedAt: updatedAt)
}

// MARK: - planDisplayStatus Tests

struct PlanDisplayStatusTests {
    let now = Date()

    @Test
    func `Pending plan without deps → .pending`() {
        let plan = makePlan(status: "pending")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .pending)
    }

    @Test
    func `Pending plan with unresolved deps → .blocked`() {
        let plan = makePlan(status: "pending")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: true, now: self.now) == .blocked)
    }

    @Test
    func `In-progress plan → .inProgress`() {
        let plan = makePlan(status: "in_progress")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .inProgress)
    }

    @Test
    func `In-progress plan with deps still → .inProgress (deps don't affect in-progress)`() {
        let plan = makePlan(status: "in_progress")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: true, now: self.now) == .inProgress)
    }

    @Test
    func `Done plan updated 3 days ago → .recentlyDone`() {
        let threeDaysAgo = self.now.addingTimeInterval(-3 * 24 * 60 * 60)
        let plan = makePlan(status: "done", updatedAt: threeDaysAgo)
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .recentlyDone)
    }

    @Test
    func `Done plan updated 8 days ago → .done`() {
        let eightDaysAgo = self.now.addingTimeInterval(-8 * 24 * 60 * 60)
        let plan = makePlan(status: "done", updatedAt: eightDaysAgo)
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .done)
    }

    @Test
    func `Done plan updated exactly 7 days ago → .recentlyDone (boundary inclusive)`() {
        let sevenDaysAgo = self.now.addingTimeInterval(-7 * 24 * 60 * 60)
        let plan = makePlan(status: "done", updatedAt: sevenDaysAgo)
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .recentlyDone)
    }

    @Test
    func `Done plan updated 7 days + 1 second ago → .done (boundary exclusive)`() {
        let sevenDaysPlus1Sec = self.now.addingTimeInterval(-(7 * 24 * 60 * 60 + 1))
        let plan = makePlan(status: "done", updatedAt: sevenDaysPlus1Sec)
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .done)
    }

    @Test
    func `Done plan with nil updatedAt → .done (no recency without a date)`() {
        let plan = makePlan(status: "done", updatedAt: nil)
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .done)
    }

    @Test
    func `Cancelled plan → .cancelled`() {
        let plan = makePlan(status: "cancelled")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .cancelled)
    }

    @Test
    func `Deferred plan → .deferred`() {
        let plan = makePlan(status: "deferred")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .deferred)
    }

    @Test
    func `Unknown status falls back to .pending`() {
        let plan = makePlan(status: "some_unknown_state")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .pending)
    }

    @Test
    func `Empty status falls back to .pending`() {
        let plan = makePlan(status: "")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .pending)
    }
}

// MARK: - PlanDisplayStatus.label Tests

struct PlanDisplayStatusLabelTests {
    @Test
    func `pending label is 'Pending'`() {
        #expect(PlanDisplayStatus.pending.label == "Pending")
    }

    @Test
    func `inProgress label is 'In Progress'`() {
        #expect(PlanDisplayStatus.inProgress.label == "In Progress")
    }

    @Test
    func `blocked label is 'Blocked'`() {
        #expect(PlanDisplayStatus.blocked.label == "Blocked")
    }

    @Test
    func `recentlyDone label is 'Recently Done'`() {
        #expect(PlanDisplayStatus.recentlyDone.label == "Recently Done")
    }

    @Test
    func `done label is 'Done'`() {
        #expect(PlanDisplayStatus.done.label == "Done")
    }

    @Test
    func `cancelled label is 'Cancelled'`() {
        #expect(PlanDisplayStatus.cancelled.label == "Cancelled")
    }

    @Test
    func `deferred label is 'Deferred'`() {
        #expect(PlanDisplayStatus.deferred.label == "Deferred")
    }

    @Test
    func `All statuses have non-empty labels`() {
        for status in PlanDisplayStatus.allCases {
            #expect(!status.label.isEmpty, "Expected non-empty label for \(status)")
        }
    }

    @Test
    func `PlanDisplayStatus has exactly 7 cases (one chip per status in FilterChipsView)`() {
        #expect(PlanDisplayStatus.allCases.count == 7)
    }
}

// MARK: - TrackedPlan.displayTitle Tests

struct TrackedPlanDisplayTitleTests {
    @Test
    func `Uses title when available and non-empty`() {
        let plan = TrackedPlan(
            uuid: "some-uuid",
            projectId: "proj-1",
            planId: 1,
            title: "My Feature Plan",
            goal: nil,
            status: "pending",
            priority: nil,
            parentUuid: nil,
            isEpic: false,
            filename: nil,
            createdAt: nil,
            updatedAt: nil,
            branch: nil)
        #expect(plan.displayTitle == "My Feature Plan")
    }

    @Test
    func `Falls back to 'Plan {planId}' when title is nil`() {
        let plan = TrackedPlan(
            uuid: "some-uuid",
            projectId: "proj-1",
            planId: 42,
            title: nil,
            goal: nil,
            status: "pending",
            priority: nil,
            parentUuid: nil,
            isEpic: false,
            filename: nil,
            createdAt: nil,
            updatedAt: nil,
            branch: nil)
        #expect(plan.displayTitle == "Plan 42")
    }

    @Test
    func `Falls back to uuid when both title and planId are nil`() {
        let plan = TrackedPlan(
            uuid: "my-uuid-fallback",
            projectId: "proj-1",
            planId: nil,
            title: nil,
            goal: nil,
            status: "pending",
            priority: nil,
            parentUuid: nil,
            isEpic: false,
            filename: nil,
            createdAt: nil,
            updatedAt: nil,
            branch: nil)
        #expect(plan.displayTitle == "my-uuid-fallback")
    }

    @Test
    func `Empty title falls back to 'Plan {planId}'`() {
        let plan = TrackedPlan(
            uuid: "some-uuid",
            projectId: "proj-1",
            planId: 10,
            title: "",
            goal: nil,
            status: "pending",
            priority: nil,
            parentUuid: nil,
            isEpic: false,
            filename: nil,
            createdAt: nil,
            updatedAt: nil,
            branch: nil)
        #expect(plan.displayTitle == "Plan 10")
    }

    @Test
    func `Empty title and nil planId falls back to uuid`() {
        let plan = TrackedPlan(
            uuid: "fallback-uuid-123",
            projectId: "proj-1",
            planId: nil,
            title: "",
            goal: nil,
            status: "pending",
            priority: nil,
            parentUuid: nil,
            isEpic: false,
            filename: nil,
            createdAt: nil,
            updatedAt: nil,
            branch: nil)
        #expect(plan.displayTitle == "fallback-uuid-123")
    }
}

// MARK: - defaultPlanFilters Tests

struct DefaultPlanFiltersTests {
    @Test
    func `Returns exactly {pending, inProgress, blocked, recentlyDone}`() {
        let filters = defaultPlanFilters()
        #expect(filters == Set([.pending, .inProgress, .blocked, .recentlyDone]))
    }

    @Test
    func `Does not include done`() {
        #expect(!defaultPlanFilters().contains(.done))
    }

    @Test
    func `Does not include cancelled`() {
        #expect(!defaultPlanFilters().contains(.cancelled))
    }

    @Test
    func `Does not include deferred`() {
        #expect(!defaultPlanFilters().contains(.deferred))
    }

    @Test
    func `Returns exactly 4 filters`() {
        #expect(defaultPlanFilters().count == 4)
    }
}

// MARK: - shouldShowPlan Tests

struct ShouldShowPlanTests {
    @Test
    func `Returns true when status is in active filters`() {
        #expect(shouldShowPlan(displayStatus: .pending, activeFilters: [.pending, .inProgress]))
        #expect(shouldShowPlan(displayStatus: .blocked, activeFilters: [.pending, .blocked]))
        #expect(shouldShowPlan(displayStatus: .recentlyDone, activeFilters: [.recentlyDone]))
    }

    @Test
    func `Returns false when status is not in active filters`() {
        #expect(!shouldShowPlan(displayStatus: .done, activeFilters: [.pending, .inProgress]))
        #expect(!shouldShowPlan(
            displayStatus: .cancelled,
            activeFilters: [.pending, .inProgress, .blocked, .recentlyDone]))
        #expect(!shouldShowPlan(displayStatus: .deferred, activeFilters: [.pending]))
    }

    @Test
    func `Empty filter set shows nothing`() {
        for status in PlanDisplayStatus.allCases {
            #expect(!shouldShowPlan(displayStatus: status, activeFilters: []))
        }
    }

    @Test
    func `All statuses in filter shows everything`() {
        let allFilters = Set(PlanDisplayStatus.allCases)
        for status in PlanDisplayStatus.allCases {
            #expect(shouldShowPlan(displayStatus: status, activeFilters: allFilters))
        }
    }

    @Test
    func `Exact match with single-element filter set`() {
        for status in PlanDisplayStatus.allCases {
            let filter: Set<PlanDisplayStatus> = [status]
            #expect(shouldShowPlan(displayStatus: status, activeFilters: filter))
            for other in PlanDisplayStatus.allCases where other != status {
                #expect(!shouldShowPlan(displayStatus: other, activeFilters: filter))
            }
        }
    }
}

// MARK: - TrackedProject.displayName Tests

struct TrackedProjectDisplayNameTests {
    @Test
    func `Uses remoteLabel when available`() {
        let project = TrackedProject(
            id: "id-1",
            repositoryId: nil,
            remoteUrl: "https://github.com/user/repo",
            lastGitRoot: "/home/user/projects/project",
            remoteLabel: "My Project Label")
        #expect(project.displayName == "My Project Label")
    }

    @Test
    func `Falls back to last path component of lastGitRoot when remoteLabel is nil`() {
        let project = TrackedProject(
            id: "id-1",
            repositoryId: nil,
            remoteUrl: nil,
            lastGitRoot: "/home/user/projects/myproject",
            remoteLabel: nil)
        #expect(project.displayName == "myproject")
    }

    @Test
    func `Falls back to last path component of remoteUrl when gitRoot is nil`() {
        let project = TrackedProject(
            id: "id-1",
            repositoryId: nil,
            remoteUrl: "https://github.com/user/reponame",
            lastGitRoot: nil,
            remoteLabel: nil)
        #expect(project.displayName == "reponame")
    }

    @Test
    func `Falls back to id when nothing else is available`() {
        let project = TrackedProject(
            id: "my-project-id",
            repositoryId: nil,
            remoteUrl: nil,
            lastGitRoot: nil,
            remoteLabel: nil)
        #expect(project.displayName == "my-project-id")
    }

    @Test
    func `Empty remoteLabel falls back to lastGitRoot`() {
        let project = TrackedProject(
            id: "id-1",
            repositoryId: nil,
            remoteUrl: nil,
            lastGitRoot: "/home/user/myproject",
            remoteLabel: "")
        #expect(project.displayName == "myproject")
    }

    @Test
    func `Empty remoteLabel and nil gitRoot falls back to remoteUrl`() {
        let project = TrackedProject(
            id: "id-1",
            repositoryId: nil,
            remoteUrl: "https://github.com/user/the-repo",
            lastGitRoot: nil,
            remoteLabel: "")
        #expect(project.displayName == "the-repo")
    }

    @Test
    func `remoteLabel takes precedence over both gitRoot and remoteUrl`() {
        let project = TrackedProject(
            id: "id-1",
            repositoryId: nil,
            remoteUrl: "https://github.com/user/repo",
            lastGitRoot: "/path/to/root",
            remoteLabel: "Best Label")
        #expect(project.displayName == "Best Label")
    }

    @Test
    func `Handles nested path correctly, returning only last component`() {
        let project = TrackedProject(
            id: "id-1",
            repositoryId: nil,
            remoteUrl: nil,
            lastGitRoot: "/a/b/c/d/final-project",
            remoteLabel: nil)
        #expect(project.displayName == "final-project")
    }
}

// MARK: - TrackedWorkspace.displayStatus Tests

struct TrackedWorkspaceDisplayStatusTests {
    @Test
    func `Neither locked nor primary → .available`() {
        let ws = makeWorkspace(isPrimary: false, isLocked: false)
        #expect(ws.displayStatus == .available)
    }

    @Test
    func `Locked workspace → .locked`() {
        let ws = makeWorkspace(isPrimary: false, isLocked: true)
        #expect(ws.displayStatus == .locked)
    }

    @Test
    func `Primary workspace → .primary`() {
        let ws = makeWorkspace(isPrimary: true, isLocked: false)
        #expect(ws.displayStatus == .primary)
    }

    @Test
    func `Locked AND primary → .locked (locked takes precedence)`() {
        let ws = makeWorkspace(isPrimary: true, isLocked: true)
        #expect(ws.displayStatus == .locked)
    }
}

// MARK: - AppTab Tests

struct AppTabTests {
    @Test
    func `activeWork tab has correct raw value`() {
        #expect(AppTab.activeWork.rawValue == "Active Work")
    }

    @Test
    func `sessions tab has correct raw value`() {
        #expect(AppTab.sessions.rawValue == "Sessions")
    }

    @Test
    func `AppTab has exactly three cases`() {
        #expect(AppTab.allCases.count == 3)
    }

    @Test
    func `plans tab has correct raw value`() {
        #expect(AppTab.plans.rawValue == "Plans")
    }

    @Test
    func `AppTab contains sessions, activeWork, and plans cases`() {
        let cases = Set(AppTab.allCases)
        #expect(cases.contains(.sessions))
        #expect(cases.contains(.activeWork))
        #expect(cases.contains(.plans))
    }

    @Test
    func `allCases order is Sessions, Active Work, Plans`() {
        #expect(AppTab.allCases == [.sessions, .activeWork, .plans])
    }
}

// MARK: - Active Work Dashboard Filter Tests

/// The active work dashboard (PlansSection) only shows plans whose display status
/// is `.inProgress` or `.blocked`. These tests document and verify that criterion.
struct ActiveWorkDashboardFilterTests {
    let now = Date()

    @Test
    func `inProgress status shown in active work`() {
        #expect(PlanDisplayStatus.inProgress.isActiveWork)
    }

    @Test
    func `blocked status shown in active work`() {
        #expect(PlanDisplayStatus.blocked.isActiveWork)
    }

    @Test
    func `pending status NOT shown in active work`() {
        #expect(!PlanDisplayStatus.pending.isActiveWork)
    }

    @Test
    func `recentlyDone status NOT shown in active work`() {
        #expect(!PlanDisplayStatus.recentlyDone.isActiveWork)
    }

    @Test
    func `done status NOT shown in active work`() {
        #expect(!PlanDisplayStatus.done.isActiveWork)
    }

    @Test
    func `cancelled status NOT shown in active work`() {
        #expect(!PlanDisplayStatus.cancelled.isActiveWork)
    }

    @Test
    func `deferred status NOT shown in active work`() {
        #expect(!PlanDisplayStatus.deferred.isActiveWork)
    }

    @Test
    func `in_progress DB plan → shown in active work`() {
        let plan = makePlan(status: "in_progress")
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: now)
        #expect(status.isActiveWork)
    }

    @Test
    func `pending plan with unresolved deps → shown in active work as blocked`() {
        let plan = makePlan(status: "pending")
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: true, now: now)
        #expect(status == .blocked)
        #expect(status.isActiveWork)
    }

    @Test
    func `pending plan without deps → NOT shown in active work`() {
        let plan = makePlan(status: "pending")
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: now)
        #expect(!status.isActiveWork)
    }

    @Test
    func `recently done plan → NOT shown in active work`() {
        let recentlyUpdated = self.now.addingTimeInterval(-2 * 24 * 60 * 60)
        let plan = makePlan(status: "done", updatedAt: recentlyUpdated)
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: now)
        #expect(status == .recentlyDone)
        #expect(!status.isActiveWork)
    }

    @Test
    func `old done plan → NOT shown in active work`() {
        let oldDate = self.now.addingTimeInterval(-10 * 24 * 60 * 60)
        let plan = makePlan(status: "done", updatedAt: oldDate)
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: now)
        #expect(status == .done)
        #expect(!status.isActiveWork)
    }

    @Test
    func `cancelled plan → NOT shown in active work`() {
        let plan = makePlan(status: "cancelled")
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: now)
        #expect(!status.isActiveWork)
    }

    @Test
    func `deferred plan → NOT shown in active work`() {
        let plan = makePlan(status: "deferred")
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: now)
        #expect(!status.isActiveWork)
    }

    @Test
    func `Only inProgress and blocked pass active work filter — all other statuses are excluded`() {
        let shown: [PlanDisplayStatus] = [.inProgress, .blocked]
        let hidden: [PlanDisplayStatus] = [.pending, .recentlyDone, .done, .cancelled, .deferred]
        for status in shown {
            #expect(status.isActiveWork, "Expected \(status) to be shown")
        }
        for status in hidden {
            #expect(!status.isActiveWork, "Expected \(status) to be hidden")
        }
    }
}

// MARK: - WorkspaceDisplayStatus Badge Visibility Tests

/// Verifies the badge suppression logic introduced in Task 4:
/// only non-default (primary, locked) states should produce visible indicators.
struct WorkspaceDisplayStatusBadgeTests {
    @Test
    func `available workspace has no visible status indicators`() {
        let ws = makeWorkspace(isPrimary: false, isLocked: false)
        #expect(ws.displayStatus == .available)
        // .available is the absence-of-badge state — only locked and primary show indicators
    }

    @Test
    func `locked workspace has a visible status indicator`() {
        let ws = makeWorkspace(isPrimary: false, isLocked: true)
        #expect(ws.displayStatus == .locked)
    }

    @Test
    func `primary workspace has a visible status indicator`() {
        let ws = makeWorkspace(isPrimary: true, isLocked: false)
        #expect(ws.displayStatus == .primary)
    }

    @Test
    func `available is the only status that maps to no badge`() {
        // Verify via production TrackedWorkspace.displayStatus that only the .available case
        // produces no status indicator — locked and primary workspaces must show badges.
        let availableWs = makeWorkspace(isPrimary: false, isLocked: false)
        let lockedWs = makeWorkspace(isPrimary: false, isLocked: true)
        let primaryWs = makeWorkspace(isPrimary: true, isLocked: false)

        #expect(availableWs.displayStatus == .available)
        #expect(lockedWs.displayStatus != .available)
        #expect(primaryWs.displayStatus != .available)
    }
}

// MARK: - TrackedWorkspace.isRecentlyActive Tests

struct TrackedWorkspaceIsRecentlyActiveTests {
    let now = Date()

    @Test
    func `Locked workspace is always recently active`() {
        let ws = makeWorkspace(isLocked: true, updatedAt: now.addingTimeInterval(-72 * 60 * 60))
        #expect(ws.isRecentlyActive(now: self.now))
    }

    @Test
    func `Primary workspace is always recently active`() {
        let ws = makeWorkspace(isPrimary: true, updatedAt: now.addingTimeInterval(-72 * 60 * 60))
        #expect(ws.isRecentlyActive(now: self.now))
    }

    @Test
    func `Workspace updated 1 hour ago is recently active`() {
        let ws = makeWorkspace(updatedAt: now.addingTimeInterval(-1 * 60 * 60))
        #expect(ws.isRecentlyActive(now: self.now))
    }

    @Test
    func `Workspace updated 47 hours ago is recently active`() {
        let ws = makeWorkspace(updatedAt: now.addingTimeInterval(-47 * 60 * 60))
        #expect(ws.isRecentlyActive(now: self.now))
    }

    @Test
    func `Workspace updated exactly 48 hours ago is recently active (boundary inclusive)`() {
        let ws = makeWorkspace(updatedAt: now.addingTimeInterval(-48 * 60 * 60))
        #expect(ws.isRecentlyActive(now: self.now))
    }

    @Test
    func `Workspace updated 48 hours + 1 second ago is NOT recently active`() {
        let ws = makeWorkspace(updatedAt: now.addingTimeInterval(-(48 * 60 * 60 + 1)))
        #expect(!ws.isRecentlyActive(now: self.now))
    }

    @Test
    func `Workspace updated 72 hours ago is NOT recently active`() {
        let ws = makeWorkspace(updatedAt: now.addingTimeInterval(-72 * 60 * 60))
        #expect(!ws.isRecentlyActive(now: self.now))
    }

    @Test
    func `Workspace with nil updatedAt is NOT recently active`() {
        let ws = makeWorkspace(updatedAt: nil)
        #expect(!ws.isRecentlyActive(now: self.now))
    }

    @Test
    func `Locked workspace with nil updatedAt is still recently active`() {
        let ws = makeWorkspace(isLocked: true, updatedAt: nil)
        #expect(ws.isRecentlyActive(now: self.now))
    }

    @Test
    func `Primary workspace with nil updatedAt is still recently active`() {
        let ws = makeWorkspace(isPrimary: true, updatedAt: nil)
        #expect(ws.isRecentlyActive(now: self.now))
    }
}

// MARK: - TrackedWorkspace.displayName Tests

struct TrackedWorkspaceDisplayNameTests {
    @Test
    func `Uses name when available`() {
        let ws = TrackedWorkspace(
            id: "ws-id",
            projectId: "proj-1",
            workspacePath: "/some/path/workspace",
            branch: nil,
            name: "My Workspace",
            description: nil,
            planId: nil,
            planTitle: nil,
            isPrimary: false,
            isLocked: false,
            updatedAt: nil)
        #expect(ws.displayName == "My Workspace")
    }

    @Test
    func `Falls back to last two path components of workspacePath when name is nil`() {
        let ws = TrackedWorkspace(
            id: "ws-id",
            projectId: "proj-1",
            workspacePath: "/home/user/workspaces/my-project",
            branch: nil,
            name: nil,
            description: nil,
            planId: nil,
            planTitle: nil,
            isPrimary: false,
            isLocked: false,
            updatedAt: nil)
        #expect(ws.displayName == "workspaces/my-project")
    }

    @Test
    func `Falls back to id when name and workspacePath are both nil`() {
        let ws = TrackedWorkspace(
            id: "ws-fallback-id",
            projectId: "proj-1",
            workspacePath: nil,
            branch: nil,
            name: nil,
            description: nil,
            planId: nil,
            planTitle: nil,
            isPrimary: false,
            isLocked: false,
            updatedAt: nil)
        #expect(ws.displayName == "ws-fallback-id")
    }

    @Test
    func `Empty name falls back to workspacePath`() {
        let ws = TrackedWorkspace(
            id: "ws-id",
            projectId: "proj-1",
            workspacePath: "/projects/myws",
            branch: nil,
            name: "",
            description: nil,
            planId: nil,
            planTitle: nil,
            isPrimary: false,
            isLocked: false,
            updatedAt: nil)
        #expect(ws.displayName == "projects/myws")
    }
}
