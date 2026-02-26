import Foundation
import Testing
@testable import TimGUI

// MARK: - Helpers

private func makePlan(
    planId: Int? = 1,
    title: String? = "Test Plan",
    goal: String? = nil,
    status: String = "pending",
    priority: String? = nil,
    updatedAt: Date? = nil,
    uuid: String = UUID().uuidString) -> TrackedPlan
{
    TrackedPlan(
        uuid: uuid,
        projectId: "proj-1",
        planId: planId,
        title: title,
        goal: goal,
        status: status,
        priority: priority,
        parentUuid: nil,
        isEpic: false,
        filename: nil,
        createdAt: nil,
        updatedAt: updatedAt,
        branch: nil)
}

// MARK: - PlanSortOrder.label Tests

@Suite("PlanSortOrder.label")
struct PlanSortOrderLabelTests {
    @Test("planNumber label is 'Plan Number'")
    func planNumberLabel() {
        #expect(PlanSortOrder.planNumber.label == "Plan Number")
    }

    @Test("priority label is 'Priority'")
    func priorityLabel() {
        #expect(PlanSortOrder.priority.label == "Priority")
    }

    @Test("recentlyUpdated label is 'Recently Updated'")
    func recentlyUpdatedLabel() {
        #expect(PlanSortOrder.recentlyUpdated.label == "Recently Updated")
    }

    @Test("status label is 'Status'")
    func statusLabel() {
        #expect(PlanSortOrder.status.label == "Status")
    }

    @Test("All sort order cases have non-empty labels")
    func allCasesHaveNonEmptyLabels() {
        for order in PlanSortOrder.allCases {
            #expect(!order.label.isEmpty, "Expected non-empty label for \(order)")
        }
    }

    @Test("PlanSortOrder has exactly 4 cases")
    func exactlyFourCases() {
        #expect(PlanSortOrder.allCases.count == 4)
    }
}

// MARK: - PlanSortOrder: planNumber

@Suite("PlanSortOrder.sorted – planNumber")
struct PlanSortOrderPlanNumberTests {
    let now = Date()

    @Test("Sorts plans by planId descending")
    func sortsByPlanIdDescending() {
        let p1 = makePlan(planId: 10)
        let p2 = makePlan(planId: 3)
        let p3 = makePlan(planId: 50)
        let p4 = makePlan(planId: 7)

        let result = PlanSortOrder.planNumber.sorted(
            [p1, p2, p3, p4],
            dependencyStatus: [:],
            now: self.now)

        #expect(result.map(\.planId) == [50, 10, 7, 3])
    }

    @Test("Plans with nil planId treated as 0 (sorted last)")
    func nilPlanIdSortedLast() {
        let p1 = makePlan(planId: 5)
        let p2 = makePlan(planId: nil)
        let p3 = makePlan(planId: 2)

        let result = PlanSortOrder.planNumber.sorted(
            [p1, p2, p3],
            dependencyStatus: [:],
            now: self.now)

        // nil becomes 0, so order is: 5, 2, 0(nil)
        #expect(result[0].planId == 5)
        #expect(result[1].planId == 2)
        #expect(result[2].planId == nil)
    }

    @Test("Empty list returns empty")
    func emptyListReturnsEmpty() {
        let result = PlanSortOrder.planNumber.sorted([], dependencyStatus: [:], now: self.now)
        #expect(result.isEmpty)
    }

    @Test("Single-element list returns same element")
    func singleElementList() {
        let plan = makePlan(planId: 42)
        let result = PlanSortOrder.planNumber.sorted([plan], dependencyStatus: [:], now: self.now)
        #expect(result.count == 1)
        #expect(result[0].planId == 42)
    }

    @Test("All nil planIds — all equal, list preserved in stable order")
    func allNilPlanIds() {
        let p1 = makePlan(planId: nil, uuid: "a")
        let p2 = makePlan(planId: nil, uuid: "b")
        let p3 = makePlan(planId: nil, uuid: "c")

        let result = PlanSortOrder.planNumber.sorted(
            [p1, p2, p3],
            dependencyStatus: [:],
            now: self.now)

        #expect(result.count == 3)
    }
}

// MARK: - PlanSortOrder: priority

@Suite("PlanSortOrder.sorted – priority")
struct PlanSortOrderPriorityTests {
    let now = Date()

    @Test("Sorts plans urgent > high > medium > low > nil/unknown")
    func sortsByPriorityHighToLow() {
        let low = makePlan(priority: "low", uuid: "low")
        let urgent = makePlan(priority: "urgent", uuid: "urgent")
        let medium = makePlan(priority: "medium", uuid: "medium")
        let high = makePlan(priority: "high", uuid: "high")
        let none = makePlan(priority: nil, uuid: "none")

        let result = PlanSortOrder.priority.sorted(
            [low, medium, none, urgent, high],
            dependencyStatus: [:],
            now: self.now)

        #expect(result.map(\.uuid) == ["urgent", "high", "medium", "low", "none"])
    }

    @Test("Priority matching is case-insensitive")
    func priorityCaseInsensitive() {
        let upper = makePlan(priority: "HIGH", uuid: "upper")
        let lower = makePlan(priority: "medium", uuid: "lower")
        let mixed = makePlan(priority: "Urgent", uuid: "mixed")

        let result = PlanSortOrder.priority.sorted(
            [lower, upper, mixed],
            dependencyStatus: [:],
            now: self.now)

        #expect(result.map(\.uuid) == ["mixed", "upper", "lower"])
    }

    @Test("Unknown priority string treated as lowest (same rank as nil)")
    func unknownPriorityTreatedAsLowest() {
        let high = makePlan(priority: "high", uuid: "high")
        let unknown = makePlan(priority: "critical", uuid: "unknown")
        let nilPriority = makePlan(priority: nil, uuid: "nil")

        let result = PlanSortOrder.priority.sorted(
            [nilPriority, high, unknown],
            dependencyStatus: [:],
            now: self.now)

        // high comes first; unknown and nil have the same rank (4)
        #expect(result[0].uuid == "high")
        #expect(Set(result[1...].map(\.uuid)) == Set(["unknown", "nil"]))
    }

    @Test("Empty list returns empty")
    func emptyListReturnsEmpty() {
        let result = PlanSortOrder.priority.sorted([], dependencyStatus: [:], now: self.now)
        #expect(result.isEmpty)
    }

    @Test("All same priority — all equal")
    func allSamePriority() {
        let plans = (1...3).map { makePlan(priority: "medium", uuid: "p\($0)") }
        let result = PlanSortOrder.priority.sorted(plans, dependencyStatus: [:], now: self.now)
        #expect(result.count == 3)
    }
}

// MARK: - PlanSortOrder: recentlyUpdated

@Suite("PlanSortOrder.sorted – recentlyUpdated")
struct PlanSortOrderRecentlyUpdatedTests {
    let now = Date()

    @Test("Sorts plans by updatedAt descending (most recent first)")
    func sortsByUpdatedAtDescending() {
        let oneHourAgo = now.addingTimeInterval(-1 * 60 * 60)
        let oneDayAgo = now.addingTimeInterval(-24 * 60 * 60)
        let oneWeekAgo = now.addingTimeInterval(-7 * 24 * 60 * 60)

        let p1 = makePlan(updatedAt: oneDayAgo, uuid: "day")
        let p2 = makePlan(updatedAt: oneWeekAgo, uuid: "week")
        let p3 = makePlan(updatedAt: oneHourAgo, uuid: "hour")

        let result = PlanSortOrder.recentlyUpdated.sorted(
            [p1, p2, p3],
            dependencyStatus: [:],
            now: self.now)

        #expect(result.map(\.uuid) == ["hour", "day", "week"])
    }

    @Test("Plans with nil updatedAt sorted last (treated as distantPast)")
    func nilUpdatedAtSortedLast() {
        let recent = makePlan(updatedAt: now.addingTimeInterval(-60), uuid: "recent")
        let nilDate = makePlan(updatedAt: nil, uuid: "nil")
        let old = makePlan(updatedAt: now.addingTimeInterval(-30 * 24 * 60 * 60), uuid: "old")

        let result = PlanSortOrder.recentlyUpdated.sorted(
            [nilDate, recent, old],
            dependencyStatus: [:],
            now: self.now)

        #expect(result[0].uuid == "recent")
        #expect(result[1].uuid == "old")
        #expect(result[2].uuid == "nil")
    }

    @Test("All nil updatedAt — all equal")
    func allNilUpdatedAt() {
        let plans = (1...3).map { makePlan(updatedAt: nil, uuid: "p\($0)") }
        let result = PlanSortOrder.recentlyUpdated.sorted(
            plans,
            dependencyStatus: [:],
            now: self.now)
        #expect(result.count == 3)
    }

    @Test("Empty list returns empty")
    func emptyListReturnsEmpty() {
        let result = PlanSortOrder.recentlyUpdated.sorted([], dependencyStatus: [:], now: self.now)
        #expect(result.isEmpty)
    }
}

// MARK: - PlanSortOrder: status

@Suite("PlanSortOrder.sorted – status")
struct PlanSortOrderStatusTests {
    let now = Date()

    @Test("Sorts plans by display status rank: inProgress < blocked < pending < recentlyDone < deferred < done < cancelled")
    func sortsByStatusRank() {
        let recentlyDoneDate = now.addingTimeInterval(-2 * 24 * 60 * 60)

        let inProgress = makePlan(status: "in_progress", uuid: "inProgress")
        let cancelled = makePlan(status: "cancelled", uuid: "cancelled")
        let deferred = makePlan(status: "deferred", uuid: "deferred")
        let pending = makePlan(status: "pending", uuid: "pending")
        let done = makePlan(status: "done", updatedAt: now.addingTimeInterval(-14 * 24 * 60 * 60), uuid: "done")
        let recentlyDone = makePlan(status: "done", updatedAt: recentlyDoneDate, uuid: "recentlyDone")
        let blocked = makePlan(status: "pending", uuid: "blocked")

        let result = PlanSortOrder.status.sorted(
            [cancelled, deferred, pending, done, recentlyDone, inProgress, blocked],
            dependencyStatus: ["blocked": true],  // blocked has unresolved deps
            now: self.now)

        #expect(result.map(\.uuid) == [
            "inProgress",
            "blocked",
            "pending",
            "recentlyDone",
            "deferred",
            "done",
            "cancelled",
        ])
    }

    @Test("Pending plan with unresolved dependency → ranked as blocked")
    func pendingWithDepRankedAsBlocked() {
        let pendingBlocked = makePlan(status: "pending", uuid: "pb")
        let normalPending = makePlan(status: "pending", uuid: "p")

        let result = PlanSortOrder.status.sorted(
            [normalPending, pendingBlocked],
            dependencyStatus: [pendingBlocked.uuid: true],
            now: self.now)

        // pendingBlocked is ranked as .blocked (rank 1), normalPending as .pending (rank 2)
        #expect(result[0].uuid == "pb")
        #expect(result[1].uuid == "p")
    }

    @Test("Done plan updated 3 days ago → ranked as recentlyDone (rank 3)")
    func recentDoneRankedCorrectly() {
        let recentDone = makePlan(
            status: "done",
            updatedAt: now.addingTimeInterval(-3 * 24 * 60 * 60),
            uuid: "recent")
        let oldDone = makePlan(
            status: "done",
            updatedAt: now.addingTimeInterval(-14 * 24 * 60 * 60),
            uuid: "old")
        let pending = makePlan(status: "pending", uuid: "pending")

        let result = PlanSortOrder.status.sorted(
            [oldDone, recentDone, pending],
            dependencyStatus: [:],
            now: self.now)

        // pending (rank 2) < recentlyDone (rank 3) < done (rank 5)
        #expect(result.map(\.uuid) == ["pending", "recent", "old"])
    }

    @Test("Empty list returns empty")
    func emptyListReturnsEmpty() {
        let result = PlanSortOrder.status.sorted([], dependencyStatus: [:], now: self.now)
        #expect(result.isEmpty)
    }
}

// MARK: - filterPlansBySearchText Tests

@Suite("filterPlansBySearchText")
struct FilterPlansBySearchTextTests {
    @Test("Empty query returns all plans unchanged")
    func emptyQueryReturnsAll() {
        let plans = [
            makePlan(title: "Feature A", goal: "Do something"),
            makePlan(title: "Bug Fix", goal: "Fix a crash"),
        ]
        let result = filterPlansBySearchText(plans, query: "")
        #expect(result.count == 2)
    }

    @Test("Whitespace-only query returns all plans unchanged")
    func whitespaceOnlyQueryReturnsAll() {
        let plans = [
            makePlan(title: "Feature A"),
            makePlan(title: "Bug Fix"),
        ]
        let result = filterPlansBySearchText(plans, query: "   ")
        #expect(result.count == 2)
    }

    @Test("Query matches title exactly")
    func queryMatchesTitleExact() {
        let matching = makePlan(title: "Authentication Feature", uuid: "match")
        let nonMatching = makePlan(title: "Database Migration", uuid: "no-match")

        let result = filterPlansBySearchText([matching, nonMatching], query: "Authentication Feature")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test("Query matches title case-insensitively")
    func queryMatchesTitleCaseInsensitive() {
        let plan = makePlan(title: "Authentication Feature", uuid: "match")
        let noMatch = makePlan(title: "Unrelated Plan", uuid: "no-match")

        let resultLower = filterPlansBySearchText([plan, noMatch], query: "authentication")
        #expect(resultLower.count == 1)
        #expect(resultLower[0].uuid == "match")

        let resultUpper = filterPlansBySearchText([plan, noMatch], query: "FEATURE")
        #expect(resultUpper.count == 1)
        #expect(resultUpper[0].uuid == "match")

        let resultMixed = filterPlansBySearchText([plan, noMatch], query: "aUtHeNtIcAtIoN")
        #expect(resultMixed.count == 1)
        #expect(resultMixed[0].uuid == "match")
    }

    @Test("Query matches goal case-insensitively")
    func queryMatchesGoalCaseInsensitive() {
        let plan = makePlan(title: "Some Plan", goal: "Implement OAuth login", uuid: "match")
        let noMatch = makePlan(title: "Other Plan", goal: "Nothing relevant", uuid: "no-match")

        let result = filterPlansBySearchText([plan, noMatch], query: "oauth")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test("Query matching title but not goal — plan is included")
    func queryMatchesTitleButNotGoal() {
        let plan = makePlan(title: "Refactor Auth", goal: "Cleanup old code", uuid: "match")
        let noMatch = makePlan(title: "UI Changes", goal: "Some design work", uuid: "no-match")

        let result = filterPlansBySearchText([plan, noMatch], query: "refactor")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test("Query matching goal but not title — plan is included")
    func queryMatchesGoalButNotTitle() {
        let plan = makePlan(title: "Plan 100", goal: "Add user authentication system", uuid: "match")
        let noMatch = makePlan(title: "Plan 101", goal: "Unrelated feature", uuid: "no-match")

        let result = filterPlansBySearchText([plan, noMatch], query: "authentication")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test("Query not matching title or goal — plan is excluded")
    func queryMatchesNeither() {
        let plan = makePlan(title: "Database Optimization", goal: "Improve query performance")
        let result = filterPlansBySearchText([plan], query: "authentication")
        #expect(result.isEmpty)
    }

    @Test("nil title still matches via goal")
    func nilTitleMatchesViaGoal() {
        let plan = makePlan(title: nil, goal: "Implement search feature", uuid: "match")
        let result = filterPlansBySearchText([plan], query: "search")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test("nil goal still matches via title")
    func nilGoalMatchesViaTitle() {
        let plan = makePlan(title: "Search Feature", goal: nil, uuid: "match")
        let result = filterPlansBySearchText([plan], query: "search")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test("Both nil title and goal — does not match any query")
    func bothNilDoesNotMatch() {
        let plan = makePlan(title: nil, goal: nil)
        let result = filterPlansBySearchText([plan], query: "anything")
        #expect(result.isEmpty)
    }

    @Test("Both nil title and goal — empty query still returns the plan")
    func bothNilEmptyQueryReturnsAll() {
        let plan = makePlan(title: nil, goal: nil)
        let result = filterPlansBySearchText([plan], query: "")
        #expect(result.count == 1)
    }

    @Test("Partial substring match is accepted")
    func partialSubstringMatch() {
        let plan = makePlan(title: "Authentication Feature", uuid: "match")
        let result = filterPlansBySearchText([plan], query: "thent")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test("Multiple matching plans are all returned")
    func multipleMatchingPlansReturned() {
        let p1 = makePlan(title: "Auth Login", uuid: "a1")
        let p2 = makePlan(title: "Unrelated", goal: "Auth middleware", uuid: "a2")
        let p3 = makePlan(title: "Database work", uuid: "a3")

        let result = filterPlansBySearchText([p1, p2, p3], query: "auth")
        #expect(result.count == 2)
        #expect(Set(result.map(\.uuid)) == Set(["a1", "a2"]))
    }

    @Test("Empty plans list returns empty")
    func emptyPlansListReturnsEmpty() {
        let result = filterPlansBySearchText([], query: "anything")
        #expect(result.isEmpty)
    }

    @Test("Query with leading/trailing whitespace is trimmed before matching")
    func queryWithWhitespaceIsTrimmed() {
        let plan = makePlan(title: "Auth Feature", uuid: "match")
        let noMatch = makePlan(title: "Database Work", uuid: "no-match")

        let result = filterPlansBySearchText([plan, noMatch], query: "  auth  ")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test("Original array order is preserved for matching plans")
    func preservesOrderOfMatchingPlans() {
        let p1 = makePlan(title: "Auth: Part 1", uuid: "a")
        let p2 = makePlan(title: "Unrelated", uuid: "b")
        let p3 = makePlan(title: "Auth: Part 2", uuid: "c")
        let p4 = makePlan(title: "Auth: Part 3", uuid: "d")

        let result = filterPlansBySearchText([p1, p2, p3, p4], query: "auth")
        #expect(result.map(\.uuid) == ["a", "c", "d"])
    }
}
