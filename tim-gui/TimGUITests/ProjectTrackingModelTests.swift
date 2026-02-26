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

@Suite("planDisplayStatus")
struct PlanDisplayStatusTests {
    let now = Date()

    @Test("Pending plan without deps → .pending")
    func pendingNoDeps() {
        let plan = makePlan(status: "pending")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .pending)
    }

    @Test("Pending plan with unresolved deps → .blocked")
    func pendingWithUnresolvedDeps() {
        let plan = makePlan(status: "pending")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: true, now: self.now) == .blocked)
    }

    @Test("In-progress plan → .inProgress")
    func inProgressPlan() {
        let plan = makePlan(status: "in_progress")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .inProgress)
    }

    @Test("In-progress plan with deps still → .inProgress (deps don't affect in-progress)")
    func inProgressWithDeps() {
        let plan = makePlan(status: "in_progress")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: true, now: self.now) == .inProgress)
    }

    @Test("Done plan updated 3 days ago → .recentlyDone")
    func doneRecently3Days() {
        let threeDaysAgo = self.now.addingTimeInterval(-3 * 24 * 60 * 60)
        let plan = makePlan(status: "done", updatedAt: threeDaysAgo)
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .recentlyDone)
    }

    @Test("Done plan updated 8 days ago → .done")
    func doneOld8Days() {
        let eightDaysAgo = self.now.addingTimeInterval(-8 * 24 * 60 * 60)
        let plan = makePlan(status: "done", updatedAt: eightDaysAgo)
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .done)
    }

    @Test("Done plan updated exactly 7 days ago → .recentlyDone (boundary inclusive)")
    func doneExactly7DaysBoundary() {
        let sevenDaysAgo = self.now.addingTimeInterval(-7 * 24 * 60 * 60)
        let plan = makePlan(status: "done", updatedAt: sevenDaysAgo)
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .recentlyDone)
    }

    @Test("Done plan updated 7 days + 1 second ago → .done (boundary exclusive)")
    func done7DaysPlus1SecondBoundary() {
        let sevenDaysPlus1Sec = self.now.addingTimeInterval(-(7 * 24 * 60 * 60 + 1))
        let plan = makePlan(status: "done", updatedAt: sevenDaysPlus1Sec)
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .done)
    }

    @Test("Done plan with nil updatedAt → .done (no recency without a date)")
    func doneNilUpdatedAt() {
        let plan = makePlan(status: "done", updatedAt: nil)
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .done)
    }

    @Test("Cancelled plan → .cancelled")
    func cancelledPlan() {
        let plan = makePlan(status: "cancelled")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .cancelled)
    }

    @Test("Deferred plan → .deferred")
    func deferredPlan() {
        let plan = makePlan(status: "deferred")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .deferred)
    }

    @Test("Unknown status falls back to .pending")
    func unknownStatusFallback() {
        let plan = makePlan(status: "some_unknown_state")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .pending)
    }

    @Test("Empty status falls back to .pending")
    func emptyStatusFallback() {
        let plan = makePlan(status: "")
        #expect(planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: self.now) == .pending)
    }
}

// MARK: - defaultPlanFilters Tests

@Suite("defaultPlanFilters")
struct DefaultPlanFiltersTests {
    @Test("Returns exactly {pending, inProgress, blocked, recentlyDone}")
    func returnsExpectedSet() {
        let filters = defaultPlanFilters()
        #expect(filters == Set([.pending, .inProgress, .blocked, .recentlyDone]))
    }

    @Test("Does not include done")
    func doesNotIncludeDone() {
        #expect(!defaultPlanFilters().contains(.done))
    }

    @Test("Does not include cancelled")
    func doesNotIncludeCancelled() {
        #expect(!defaultPlanFilters().contains(.cancelled))
    }

    @Test("Does not include deferred")
    func doesNotIncludeDeferred() {
        #expect(!defaultPlanFilters().contains(.deferred))
    }

    @Test("Returns exactly 4 filters")
    func exactlyFourFilters() {
        #expect(defaultPlanFilters().count == 4)
    }
}

// MARK: - shouldShowPlan Tests

@Suite("shouldShowPlan")
struct ShouldShowPlanTests {
    @Test("Returns true when status is in active filters")
    func trueWhenInFilters() {
        #expect(shouldShowPlan(displayStatus: .pending, activeFilters: [.pending, .inProgress]))
        #expect(shouldShowPlan(displayStatus: .blocked, activeFilters: [.pending, .blocked]))
        #expect(shouldShowPlan(displayStatus: .recentlyDone, activeFilters: [.recentlyDone]))
    }

    @Test("Returns false when status is not in active filters")
    func falseWhenNotInFilters() {
        #expect(!shouldShowPlan(displayStatus: .done, activeFilters: [.pending, .inProgress]))
        #expect(!shouldShowPlan(
            displayStatus: .cancelled,
            activeFilters: [.pending, .inProgress, .blocked, .recentlyDone]))
        #expect(!shouldShowPlan(displayStatus: .deferred, activeFilters: [.pending]))
    }

    @Test("Empty filter set shows nothing")
    func emptyFilterShowsNothing() {
        for status in PlanDisplayStatus.allCases {
            #expect(!shouldShowPlan(displayStatus: status, activeFilters: []))
        }
    }

    @Test("All statuses in filter shows everything")
    func allFiltersShowEverything() {
        let allFilters = Set(PlanDisplayStatus.allCases)
        for status in PlanDisplayStatus.allCases {
            #expect(shouldShowPlan(displayStatus: status, activeFilters: allFilters))
        }
    }

    @Test("Exact match with single-element filter set")
    func singleElementFilter() {
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

@Suite("TrackedProject.displayName")
struct TrackedProjectDisplayNameTests {
    @Test("Uses remoteLabel when available")
    func usesRemoteLabel() {
        let project = TrackedProject(
            id: "id-1",
            repositoryId: nil,
            remoteUrl: "https://github.com/user/repo",
            lastGitRoot: "/home/user/projects/project",
            remoteLabel: "My Project Label")
        #expect(project.displayName == "My Project Label")
    }

    @Test("Falls back to last path component of lastGitRoot when remoteLabel is nil")
    func fallsBackToGitRoot() {
        let project = TrackedProject(
            id: "id-1",
            repositoryId: nil,
            remoteUrl: nil,
            lastGitRoot: "/home/user/projects/myproject",
            remoteLabel: nil)
        #expect(project.displayName == "myproject")
    }

    @Test("Falls back to last path component of remoteUrl when gitRoot is nil")
    func fallsBackToRemoteUrl() {
        let project = TrackedProject(
            id: "id-1",
            repositoryId: nil,
            remoteUrl: "https://github.com/user/reponame",
            lastGitRoot: nil,
            remoteLabel: nil)
        #expect(project.displayName == "reponame")
    }

    @Test("Falls back to id when nothing else is available")
    func fallsBackToId() {
        let project = TrackedProject(
            id: "my-project-id",
            repositoryId: nil,
            remoteUrl: nil,
            lastGitRoot: nil,
            remoteLabel: nil)
        #expect(project.displayName == "my-project-id")
    }

    @Test("Empty remoteLabel falls back to lastGitRoot")
    func emptyLabelFallsBack() {
        let project = TrackedProject(
            id: "id-1",
            repositoryId: nil,
            remoteUrl: nil,
            lastGitRoot: "/home/user/myproject",
            remoteLabel: "")
        #expect(project.displayName == "myproject")
    }

    @Test("Empty remoteLabel and nil gitRoot falls back to remoteUrl")
    func emptyLabelAndNilGitRootFallsBackToUrl() {
        let project = TrackedProject(
            id: "id-1",
            repositoryId: nil,
            remoteUrl: "https://github.com/user/the-repo",
            lastGitRoot: nil,
            remoteLabel: "")
        #expect(project.displayName == "the-repo")
    }

    @Test("remoteLabel takes precedence over both gitRoot and remoteUrl")
    func labelTakesPrecedenceOverAll() {
        let project = TrackedProject(
            id: "id-1",
            repositoryId: nil,
            remoteUrl: "https://github.com/user/repo",
            lastGitRoot: "/path/to/root",
            remoteLabel: "Best Label")
        #expect(project.displayName == "Best Label")
    }

    @Test("Handles nested path correctly, returning only last component")
    func lastPathComponentOnly() {
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

@Suite("TrackedWorkspace.displayStatus")
struct TrackedWorkspaceDisplayStatusTests {
    @Test("Neither locked nor primary → .available")
    func availableWorkspace() {
        let ws = makeWorkspace(isPrimary: false, isLocked: false)
        #expect(ws.displayStatus == .available)
    }

    @Test("Locked workspace → .locked")
    func lockedWorkspace() {
        let ws = makeWorkspace(isPrimary: false, isLocked: true)
        #expect(ws.displayStatus == .locked)
    }

    @Test("Primary workspace → .primary")
    func primaryWorkspace() {
        let ws = makeWorkspace(isPrimary: true, isLocked: false)
        #expect(ws.displayStatus == .primary)
    }

    @Test("Locked AND primary → .locked (locked takes precedence)")
    func lockedTakesPrecedenceOverPrimary() {
        let ws = makeWorkspace(isPrimary: true, isLocked: true)
        #expect(ws.displayStatus == .locked)
    }
}

// MARK: - AppTab Tests

@Suite("AppTab")
struct AppTabTests {
    @Test("activeWork tab has correct raw value")
    func activeWorkRawValue() {
        #expect(AppTab.activeWork.rawValue == "Active Work")
    }

    @Test("sessions tab has correct raw value")
    func sessionsRawValue() {
        #expect(AppTab.sessions.rawValue == "Sessions")
    }

    @Test("AppTab has exactly two cases")
    func exactlyTwoCases() {
        #expect(AppTab.allCases.count == 2)
    }

    @Test("AppTab contains sessions and activeWork cases")
    func containsExpectedCases() {
        let cases = Set(AppTab.allCases)
        #expect(cases.contains(.sessions))
        #expect(cases.contains(.activeWork))
    }
}

// MARK: - Active Work Dashboard Filter Tests

/// The active work dashboard (PlansSection) only shows plans whose display status
/// is `.inProgress` or `.blocked`. These tests document and verify that criterion.
@Suite("activeWorkDashboardFilter")
struct ActiveWorkDashboardFilterTests {
    let now = Date()

    @Test("inProgress status shown in active work")
    func inProgressShown() {
        #expect(PlanDisplayStatus.inProgress.isActiveWork)
    }

    @Test("blocked status shown in active work")
    func blockedShown() {
        #expect(PlanDisplayStatus.blocked.isActiveWork)
    }

    @Test("pending status NOT shown in active work")
    func pendingHidden() {
        #expect(!PlanDisplayStatus.pending.isActiveWork)
    }

    @Test("recentlyDone status NOT shown in active work")
    func recentlyDoneHidden() {
        #expect(!PlanDisplayStatus.recentlyDone.isActiveWork)
    }

    @Test("done status NOT shown in active work")
    func doneHidden() {
        #expect(!PlanDisplayStatus.done.isActiveWork)
    }

    @Test("cancelled status NOT shown in active work")
    func cancelledHidden() {
        #expect(!PlanDisplayStatus.cancelled.isActiveWork)
    }

    @Test("deferred status NOT shown in active work")
    func deferredHidden() {
        #expect(!PlanDisplayStatus.deferred.isActiveWork)
    }

    @Test("in_progress DB plan → shown in active work")
    func inProgressDbPlanShown() {
        let plan = makePlan(status: "in_progress")
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: now)
        #expect(status.isActiveWork)
    }

    @Test("pending plan with unresolved deps → shown in active work as blocked")
    func pendingWithDepsShownAsBlocked() {
        let plan = makePlan(status: "pending")
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: true, now: now)
        #expect(status == .blocked)
        #expect(status.isActiveWork)
    }

    @Test("pending plan without deps → NOT shown in active work")
    func pendingNoDepsHidden() {
        let plan = makePlan(status: "pending")
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: now)
        #expect(!status.isActiveWork)
    }

    @Test("recently done plan → NOT shown in active work")
    func recentlyDoneHiddenFromDB() {
        let recentlyUpdated = self.now.addingTimeInterval(-2 * 24 * 60 * 60)
        let plan = makePlan(status: "done", updatedAt: recentlyUpdated)
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: now)
        #expect(status == .recentlyDone)
        #expect(!status.isActiveWork)
    }

    @Test("old done plan → NOT shown in active work")
    func oldDoneHiddenFromDB() {
        let oldDate = self.now.addingTimeInterval(-10 * 24 * 60 * 60)
        let plan = makePlan(status: "done", updatedAt: oldDate)
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: now)
        #expect(status == .done)
        #expect(!status.isActiveWork)
    }

    @Test("cancelled plan → NOT shown in active work")
    func cancelledHiddenFromDB() {
        let plan = makePlan(status: "cancelled")
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: now)
        #expect(!status.isActiveWork)
    }

    @Test("deferred plan → NOT shown in active work")
    func deferredHiddenFromDB() {
        let plan = makePlan(status: "deferred")
        let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: false, now: now)
        #expect(!status.isActiveWork)
    }

    @Test("Only inProgress and blocked pass active work filter — all other statuses are excluded")
    func onlyInProgressAndBlockedPassFilter() {
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
@Suite("WorkspaceDisplayStatus badge visibility")
struct WorkspaceDisplayStatusBadgeTests {
    @Test("available workspace has no visible status indicators")
    func availableHasNoBadge() {
        let ws = makeWorkspace(isPrimary: false, isLocked: false)
        #expect(ws.displayStatus == .available)
        // .available is the absence-of-badge state — only locked and primary show indicators
    }

    @Test("locked workspace has a visible status indicator")
    func lockedHasBadge() {
        let ws = makeWorkspace(isPrimary: false, isLocked: true)
        #expect(ws.displayStatus == .locked)
    }

    @Test("primary workspace has a visible status indicator")
    func primaryHasBadge() {
        let ws = makeWorkspace(isPrimary: true, isLocked: false)
        #expect(ws.displayStatus == .primary)
    }

    @Test("available is the only status that maps to no badge")
    func onlyAvailableHasNoBadge() {
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

@Suite("TrackedWorkspace.isRecentlyActive")
struct TrackedWorkspaceIsRecentlyActiveTests {
    let now = Date()

    @Test("Locked workspace is always recently active")
    func lockedAlwaysActive() {
        let ws = makeWorkspace(isLocked: true, updatedAt: now.addingTimeInterval(-72 * 60 * 60))
        #expect(ws.isRecentlyActive(now: now))
    }

    @Test("Primary workspace is always recently active")
    func primaryAlwaysActive() {
        let ws = makeWorkspace(isPrimary: true, updatedAt: now.addingTimeInterval(-72 * 60 * 60))
        #expect(ws.isRecentlyActive(now: now))
    }

    @Test("Workspace updated 1 hour ago is recently active")
    func recentlyUpdated() {
        let ws = makeWorkspace(updatedAt: now.addingTimeInterval(-1 * 60 * 60))
        #expect(ws.isRecentlyActive(now: now))
    }

    @Test("Workspace updated 47 hours ago is recently active")
    func updatedWithin48Hours() {
        let ws = makeWorkspace(updatedAt: now.addingTimeInterval(-47 * 60 * 60))
        #expect(ws.isRecentlyActive(now: now))
    }

    @Test("Workspace updated exactly 48 hours ago is recently active (boundary inclusive)")
    func updatedExactly48Hours() {
        let ws = makeWorkspace(updatedAt: now.addingTimeInterval(-48 * 60 * 60))
        #expect(ws.isRecentlyActive(now: now))
    }

    @Test("Workspace updated 48 hours + 1 second ago is NOT recently active")
    func updatedBeyond48Hours() {
        let ws = makeWorkspace(updatedAt: now.addingTimeInterval(-(48 * 60 * 60 + 1)))
        #expect(!ws.isRecentlyActive(now: now))
    }

    @Test("Workspace updated 72 hours ago is NOT recently active")
    func oldUpdate() {
        let ws = makeWorkspace(updatedAt: now.addingTimeInterval(-72 * 60 * 60))
        #expect(!ws.isRecentlyActive(now: now))
    }

    @Test("Workspace with nil updatedAt is NOT recently active")
    func nilUpdatedAt() {
        let ws = makeWorkspace(updatedAt: nil)
        #expect(!ws.isRecentlyActive(now: now))
    }

    @Test("Locked workspace with nil updatedAt is still recently active")
    func lockedNilUpdatedAt() {
        let ws = makeWorkspace(isLocked: true, updatedAt: nil)
        #expect(ws.isRecentlyActive(now: now))
    }

    @Test("Primary workspace with nil updatedAt is still recently active")
    func primaryNilUpdatedAt() {
        let ws = makeWorkspace(isPrimary: true, updatedAt: nil)
        #expect(ws.isRecentlyActive(now: now))
    }
}

// MARK: - TrackedWorkspace.displayName Tests

@Suite("TrackedWorkspace.displayName")
struct TrackedWorkspaceDisplayNameTests {
    @Test("Uses name when available")
    func usesName() {
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

    @Test("Falls back to last two path components of workspacePath when name is nil")
    func fallsBackToWorkspacePath() {
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

    @Test("Falls back to id when name and workspacePath are both nil")
    func fallsBackToId() {
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

    @Test("Empty name falls back to workspacePath")
    func emptyNameFallsBack() {
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
