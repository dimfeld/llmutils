import Foundation
import SwiftUI
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

struct PlanSortOrderLabelTests {
    @Test
    func `planNumber label is 'Plan Number'`() {
        #expect(PlanSortOrder.planNumber.label == "Plan Number")
    }

    @Test
    func `priority label is 'Priority'`() {
        #expect(PlanSortOrder.priority.label == "Priority")
    }

    @Test
    func `recentlyUpdated label is 'Recently Updated'`() {
        #expect(PlanSortOrder.recentlyUpdated.label == "Recently Updated")
    }

    @Test
    func `All sort order cases have non-empty labels`() {
        for order in PlanSortOrder.allCases {
            #expect(!order.label.isEmpty, "Expected non-empty label for \(order)")
        }
    }

    @Test
    func `PlanSortOrder has exactly 3 cases`() {
        #expect(PlanSortOrder.allCases.count == 3)
    }
}

// MARK: - PlanSortOrder: planNumber

struct PlanSortOrderPlanNumberTests {
    let now = Date()

    @Test
    func `Sorts plans by planId descending`() {
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

    @Test
    func `Plans with nil planId treated as 0 (sorted last)`() {
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

    @Test
    func `Empty list returns empty`() {
        let result = PlanSortOrder.planNumber.sorted([], dependencyStatus: [:], now: self.now)
        #expect(result.isEmpty)
    }

    @Test
    func `Single-element list returns same element`() {
        let plan = makePlan(planId: 42)
        let result = PlanSortOrder.planNumber.sorted([plan], dependencyStatus: [:], now: self.now)
        #expect(result.count == 1)
        #expect(result[0].planId == 42)
    }

    @Test
    func `All nil planIds — all equal, list preserved in stable order`() {
        let p1 = makePlan(planId: nil, uuid: "a")
        let p2 = makePlan(planId: nil, uuid: "b")
        let p3 = makePlan(planId: nil, uuid: "c")

        let result = PlanSortOrder.planNumber.sorted(
            [p1, p2, p3],
            dependencyStatus: [:],
            now: self.now)

        #expect(result.count == 3)
    }

    @Test
    func `Same planId: sorted by updatedAt descending (DB default secondary order)`() {
        let earlier = self.now.addingTimeInterval(-3600)
        let evenEarlier = self.now.addingTimeInterval(-7200)

        let p1 = makePlan(planId: 5, updatedAt: earlier, uuid: "b")
        let p2 = makePlan(planId: 5, updatedAt: now, uuid: "a")
        let p3 = makePlan(planId: 5, updatedAt: evenEarlier, uuid: "c")

        let result = PlanSortOrder.planNumber.sorted(
            [p1, p3, p2],
            dependencyStatus: [:],
            now: self.now)

        // Same planId → sort by updatedAt descending
        #expect(result.map(\.uuid) == ["a", "b", "c"])
    }

    @Test
    func `nil planId with equal values: secondary updatedAt sort still applies`() {
        let earlier = self.now.addingTimeInterval(-3600)

        let p1 = makePlan(planId: nil, updatedAt: earlier, uuid: "b")
        let p2 = makePlan(planId: nil, updatedAt: now, uuid: "a")

        let result = PlanSortOrder.planNumber.sorted(
            [p1, p2],
            dependencyStatus: [:],
            now: self.now)

        // Both nil planId (treated as 0) → sort by updatedAt descending
        #expect(result.map(\.uuid) == ["a", "b"])
    }

    @Test
    func `Same planId and updatedAt: uuid used as final tiebreaker (ascending)`() {
        let fixedDate = Date(timeIntervalSince1970: 1_000_000)

        let p1 = makePlan(planId: 3, updatedAt: fixedDate, uuid: "z")
        let p2 = makePlan(planId: 3, updatedAt: fixedDate, uuid: "a")
        let p3 = makePlan(planId: 3, updatedAt: fixedDate, uuid: "m")

        let result = PlanSortOrder.planNumber.sorted(
            [p1, p3, p2],
            dependencyStatus: [:],
            now: self.now)

        // Same planId AND same updatedAt → sort by uuid ascending
        #expect(result.map(\.uuid) == ["a", "m", "z"])
    }
}

// MARK: - PlanSortOrder: priority

struct PlanSortOrderPriorityTests {
    let now = Date()

    @Test
    func `Sorts plans urgent > high > medium > low > nil/unknown`() {
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

    @Test
    func `Priority matching is case-insensitive`() {
        let upper = makePlan(priority: "HIGH", uuid: "upper")
        let lower = makePlan(priority: "medium", uuid: "lower")
        let mixed = makePlan(priority: "Urgent", uuid: "mixed")

        let result = PlanSortOrder.priority.sorted(
            [lower, upper, mixed],
            dependencyStatus: [:],
            now: self.now)

        #expect(result.map(\.uuid) == ["mixed", "upper", "lower"])
    }

    @Test
    func `Unknown priority string treated as lowest (same rank as nil)`() {
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

    @Test
    func `empty list returns empty`() {
        let result = PlanSortOrder.priority.sorted([], dependencyStatus: [:], now: self.now)
        #expect(result.isEmpty)
    }

    @Test
    func `All same priority — all equal`() {
        let plans = (1...3).map { makePlan(priority: "medium", uuid: "p\($0)") }
        let result = PlanSortOrder.priority.sorted(plans, dependencyStatus: [:], now: self.now)
        #expect(result.count == 3)
    }

    @Test
    func `'maybe' ranked distinctly: urgent > high > medium > low > maybe > nil/unknown`() {
        let urgent = makePlan(priority: "urgent", uuid: "urgent")
        let high = makePlan(priority: "high", uuid: "high")
        let medium = makePlan(priority: "medium", uuid: "medium")
        let low = makePlan(priority: "low", uuid: "low")
        let maybe = makePlan(priority: "maybe", uuid: "maybe")
        let none = makePlan(priority: nil, uuid: "none")

        let result = PlanSortOrder.priority.sorted(
            [none, low, medium, maybe, high, urgent],
            dependencyStatus: [:],
            now: self.now)

        #expect(result.map(\.uuid) == ["urgent", "high", "medium", "low", "maybe", "none"])
    }

    @Test
    func `'maybe' ranks above nil and unknown priority strings`() {
        let maybe = makePlan(planId: 3, priority: "maybe", uuid: "maybe")
        let none = makePlan(planId: 2, priority: nil, uuid: "none")
        let unknown = makePlan(planId: 1, priority: "critical", uuid: "unknown")

        let result = PlanSortOrder.priority.sorted(
            [none, unknown, maybe],
            dependencyStatus: [:],
            now: self.now)

        #expect(result[0].uuid == "maybe")
        #expect(Set(result[1...].map(\.uuid)) == Set(["none", "unknown"]))
    }

    @Test
    func `'maybe' ranks below 'low' priority`() {
        let low = makePlan(planId: 1, priority: "low", uuid: "low")
        let maybe = makePlan(planId: 2, priority: "maybe", uuid: "maybe")

        let result = PlanSortOrder.priority.sorted(
            [maybe, low],
            dependencyStatus: [:],
            now: self.now)

        #expect(result[0].uuid == "low")
        #expect(result[1].uuid == "maybe")
    }

    @Test
    func `Priority sort: equal priority sorted by planId descending`() {
        let p1 = makePlan(planId: 10, priority: "medium", uuid: "a")
        let p2 = makePlan(planId: 30, priority: "medium", uuid: "b")
        let p3 = makePlan(planId: 5, priority: "medium", uuid: "c")

        let result = PlanSortOrder.priority.sorted(
            [p1, p3, p2],
            dependencyStatus: [:],
            now: self.now)

        // Same priority → sort by planId descending
        #expect(result.map(\.planId) == [30, 10, 5])
    }

    @Test
    func `Priority sort: nil planId treated as 0 for tiebreaker`() {
        let withId = makePlan(planId: 5, priority: "high", uuid: "a")
        let nilId = makePlan(planId: nil, priority: "high", uuid: "b")

        let result = PlanSortOrder.priority.sorted(
            [nilId, withId],
            dependencyStatus: [:],
            now: self.now)

        // Same priority → planId DESC: 5 > nil(0)
        #expect(result[0].uuid == "a")
        #expect(result[1].uuid == "b")
    }
}

// MARK: - PlanSortOrder: recentlyUpdated

struct PlanSortOrderRecentlyUpdatedTests {
    let now = Date()

    @Test
    func `Sorts plans by updatedAt descending (most recent first)`() {
        let oneHourAgo = self.now.addingTimeInterval(-1 * 60 * 60)
        let oneDayAgo = self.now.addingTimeInterval(-24 * 60 * 60)
        let oneWeekAgo = self.now.addingTimeInterval(-7 * 24 * 60 * 60)

        let p1 = makePlan(updatedAt: oneDayAgo, uuid: "day")
        let p2 = makePlan(updatedAt: oneWeekAgo, uuid: "week")
        let p3 = makePlan(updatedAt: oneHourAgo, uuid: "hour")

        let result = PlanSortOrder.recentlyUpdated.sorted(
            [p1, p2, p3],
            dependencyStatus: [:],
            now: self.now)

        #expect(result.map(\.uuid) == ["hour", "day", "week"])
    }

    @Test
    func `Plans with nil updatedAt sorted last (treated as distantPast)`() {
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

    @Test
    func `All nil updatedAt — all equal`() {
        let plans = (1...3).map { makePlan(updatedAt: nil, uuid: "p\($0)") }
        let result = PlanSortOrder.recentlyUpdated.sorted(
            plans,
            dependencyStatus: [:],
            now: self.now)
        #expect(result.count == 3)
    }

    @Test
    func emptyListReturnsEmpty() {
        let result = PlanSortOrder.recentlyUpdated.sorted([], dependencyStatus: [:], now: self.now)
        #expect(result.isEmpty)
    }

    @Test
    func `RecentlyUpdated sort: equal updatedAt sorted by planId descending`() {
        let fixedDate = Date(timeIntervalSince1970: 1_000_000)

        let p1 = makePlan(planId: 10, updatedAt: fixedDate, uuid: "a")
        let p2 = makePlan(planId: 30, updatedAt: fixedDate, uuid: "b")
        let p3 = makePlan(planId: 5, updatedAt: fixedDate, uuid: "c")

        let result = PlanSortOrder.recentlyUpdated.sorted(
            [p1, p3, p2],
            dependencyStatus: [:],
            now: self.now)

        // Same updatedAt → sort by planId descending
        #expect(result.map(\.planId) == [30, 10, 5])
    }

    @Test
    func `RecentlyUpdated sort: nil planId treated as 0 for tiebreaker`() {
        let fixedDate = Date(timeIntervalSince1970: 1_000_000)

        let withId = makePlan(planId: 5, updatedAt: fixedDate, uuid: "a")
        let nilId = makePlan(planId: nil, updatedAt: fixedDate, uuid: "b")

        let result = PlanSortOrder.recentlyUpdated.sorted(
            [nilId, withId],
            dependencyStatus: [:],
            now: self.now)

        // Same updatedAt → planId DESC: 5 > nil(0)
        #expect(result[0].uuid == "a")
        #expect(result[1].uuid == "b")
    }
}

// MARK: - filterPlansBySearchText Tests

struct FilterPlansBySearchTextTests {
    @Test
    func `Empty query returns all plans unchanged`() {
        let plans = [
            makePlan(title: "Feature A", goal: "Do something"),
            makePlan(title: "Bug Fix", goal: "Fix a crash"),
        ]
        let result = filterPlansBySearchText(plans, query: "")
        #expect(result.count == 2)
    }

    @Test
    func `Whitespace-only query returns all plans unchanged`() {
        let plans = [
            makePlan(title: "Feature A"),
            makePlan(title: "Bug Fix"),
        ]
        let result = filterPlansBySearchText(plans, query: "   ")
        #expect(result.count == 2)
    }

    @Test
    func `Query matches title exactly`() {
        let matching = makePlan(title: "Authentication Feature", uuid: "match")
        let nonMatching = makePlan(title: "Database Migration", uuid: "no-match")

        let result = filterPlansBySearchText([matching, nonMatching], query: "Authentication Feature")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test
    func `Query matches title case-insensitively`() {
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

    @Test
    func `Query matches goal case-insensitively`() {
        let plan = makePlan(title: "Some Plan", goal: "Implement OAuth login", uuid: "match")
        let noMatch = makePlan(title: "Other Plan", goal: "Nothing relevant", uuid: "no-match")

        let result = filterPlansBySearchText([plan, noMatch], query: "oauth")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test
    func `Query matching title but not goal — plan is included`() {
        let plan = makePlan(title: "Refactor Auth", goal: "Cleanup old code", uuid: "match")
        let noMatch = makePlan(title: "UI Changes", goal: "Some design work", uuid: "no-match")

        let result = filterPlansBySearchText([plan, noMatch], query: "refactor")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test
    func `Query matching goal but not title — plan is included`() {
        let plan = makePlan(title: "Plan 100", goal: "Add user authentication system", uuid: "match")
        let noMatch = makePlan(title: "Plan 101", goal: "Unrelated feature", uuid: "no-match")

        let result = filterPlansBySearchText([plan, noMatch], query: "authentication")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test
    func `Query not matching title or goal — plan is excluded`() {
        let plan = makePlan(title: "Database Optimization", goal: "Improve query performance")
        let result = filterPlansBySearchText([plan], query: "authentication")
        #expect(result.isEmpty)
    }

    @Test
    func `nil title still matches via goal`() {
        let plan = makePlan(title: nil, goal: "Implement search feature", uuid: "match")
        let result = filterPlansBySearchText([plan], query: "search")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test
    func `nil goal still matches via title`() {
        let plan = makePlan(title: "Search Feature", goal: nil, uuid: "match")
        let result = filterPlansBySearchText([plan], query: "search")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test
    func `Both nil title and goal — does not match any query`() {
        let plan = makePlan(title: nil, goal: nil)
        let result = filterPlansBySearchText([plan], query: "anything")
        #expect(result.isEmpty)
    }

    @Test
    func `Both nil title and goal — empty query still returns the plan`() {
        let plan = makePlan(title: nil, goal: nil)
        let result = filterPlansBySearchText([plan], query: "")
        #expect(result.count == 1)
    }

    @Test
    func `Partial substring match is accepted`() {
        let plan = makePlan(title: "Authentication Feature", uuid: "match")
        let result = filterPlansBySearchText([plan], query: "thent")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test
    func `Multiple matching plans are all returned`() {
        let p1 = makePlan(title: "Auth Login", uuid: "a1")
        let p2 = makePlan(title: "Unrelated", goal: "Auth middleware", uuid: "a2")
        let p3 = makePlan(title: "Database work", uuid: "a3")

        let result = filterPlansBySearchText([p1, p2, p3], query: "auth")
        #expect(result.count == 2)
        #expect(Set(result.map(\.uuid)) == Set(["a1", "a2"]))
    }

    @Test
    func `Empty plans list returns empty`() {
        let result = filterPlansBySearchText([], query: "anything")
        #expect(result.isEmpty)
    }

    @Test
    func `Query with leading/trailing whitespace is trimmed before matching`() {
        let plan = makePlan(title: "Auth Feature", uuid: "match")
        let noMatch = makePlan(title: "Database Work", uuid: "no-match")

        let result = filterPlansBySearchText([plan, noMatch], query: "  auth  ")
        #expect(result.count == 1)
        #expect(result[0].uuid == "match")
    }

    @Test
    func `Original array order is preserved for matching plans`() {
        let p1 = makePlan(title: "Auth: Part 1", uuid: "a")
        let p2 = makePlan(title: "Unrelated", uuid: "b")
        let p3 = makePlan(title: "Auth: Part 2", uuid: "c")
        let p4 = makePlan(title: "Auth: Part 3", uuid: "d")

        let result = filterPlansBySearchText([p1, p2, p3, p4], query: "auth")
        #expect(result.map(\.uuid) == ["a", "c", "d"])
    }
}

// MARK: - planAbsoluteDateFormatter Tests

@MainActor
struct PlanDetailViewTests {
    // MARK: - planAbsoluteDateFormatter

    @Test
    func `planAbsoluteDateFormatter produces non-empty output for a known date`() throws {
        var components = DateComponents()
        components.year = 2025
        components.month = 6
        components.day = 15
        components.hour = 14
        components.minute = 30
        let date = try #require(Calendar.current.date(from: components))

        let formatted = planAbsoluteDateFormatter.string(from: date)
        #expect(!formatted.isEmpty)
    }

    @Test
    func `planAbsoluteDateFormatter includes the year in its output`() throws {
        var components = DateComponents()
        components.year = 2025
        components.month = 3
        components.day = 10
        components.hour = 9
        components.minute = 0
        let date = try #require(Calendar.current.date(from: components))

        let formatted = planAbsoluteDateFormatter.string(from: date)
        #expect(formatted.contains("2025"))
    }

    @Test
    func `planAbsoluteDateFormatter uses medium date style (includes month name or number)`() throws {
        // Medium date style in en_US locale is "Jun 15, 2025" — includes month
        // We verify the formatter uses medium date (not short like "6/15/25")
        // by checking that date and time components appear
        var components = DateComponents()
        components.year = 2025
        components.month = 6
        components.day = 15
        components.hour = 14
        components.minute = 30
        let date = try #require(Calendar.current.date(from: components))

        let formatted = planAbsoluteDateFormatter.string(from: date)
        // Medium style includes year and at least a 2-digit day
        #expect(formatted.contains("2025"))
        #expect(formatted.contains("15"))
    }

    @Test
    func `planAbsoluteDateFormatter produces different output for different dates`() throws {
        var c1 = DateComponents()
        c1.year = 2025; c1.month = 1; c1.day = 1; c1.hour = 12; c1.minute = 0
        let date1 = try #require(Calendar.current.date(from: c1))

        var c2 = DateComponents()
        c2.year = 2025; c2.month = 12; c2.day = 31; c2.hour = 23; c2.minute = 59
        let date2 = try #require(Calendar.current.date(from: c2))

        let f1 = planAbsoluteDateFormatter.string(from: date1)
        let f2 = planAbsoluteDateFormatter.string(from: date2)
        #expect(f1 != f2)
    }

    @Test
    func `planAbsoluteDateFormatter uses short time style (includes hour and minute)`() throws {
        // Short time includes hours and minutes
        var components = DateComponents()
        components.year = 2025
        components.month = 6
        components.day = 15
        components.hour = 14
        components.minute = 30
        components.second = 45 // seconds should NOT appear in short time style
        let date = try #require(Calendar.current.date(from: components))

        let formatted = planAbsoluteDateFormatter.string(from: date)
        // Should contain time information (short style: "2:30 PM" or "14:30" locale-dependent)
        #expect(!formatted.isEmpty)
        // Verify times differ for different hours
        var c2 = DateComponents()
        c2.year = 2025; c2.month = 6; c2.day = 15; c2.hour = 9; c2.minute = 15
        let date2 = try #require(Calendar.current.date(from: c2))
        let formatted2 = planAbsoluteDateFormatter.string(from: date2)
        #expect(formatted != formatted2)
    }
}

// MARK: - Plan browser defaults Tests

struct PlanBrowserDefaultsTests {
    @Test
    func `Default sort order is recentlyUpdated`() {
        #expect(planBrowserDefaultSortOrder == .recentlyUpdated)
    }
}

// MARK: - PlanDisplayStatus computed properties Tests

struct PlanDisplayStatusComputedPropertyTests {
    @Test
    func `pending has correct icon`() {
        #expect(PlanDisplayStatus.pending.icon == "circle")
    }

    @Test
    func `inProgress has correct icon`() {
        #expect(PlanDisplayStatus.inProgress.icon == "play.circle.fill")
    }

    @Test
    func `blocked has correct icon`() {
        #expect(PlanDisplayStatus.blocked.icon == "exclamationmark.circle.fill")
    }

    @Test
    func `recentlyDone has correct icon`() {
        #expect(PlanDisplayStatus.recentlyDone.icon == "checkmark.circle.fill")
    }

    @Test
    func `done has correct icon`() {
        #expect(PlanDisplayStatus.done.icon == "checkmark.circle")
    }

    @Test
    func `cancelled has correct icon`() {
        #expect(PlanDisplayStatus.cancelled.icon == "xmark.circle")
    }

    @Test
    func `deferred has correct icon`() {
        #expect(PlanDisplayStatus.deferred.icon == "clock.arrow.circlepath")
    }

    @Test
    func `All status cases have non-empty icons`() {
        for status in PlanDisplayStatus.allCases {
            #expect(!status.icon.isEmpty, "Expected non-empty icon for \(status)")
        }
    }

    @Test
    func `pending color is secondary`() {
        #expect(PlanDisplayStatus.pending.color == Color.secondary)
    }

    @Test
    func `inProgress color is blue`() {
        #expect(PlanDisplayStatus.inProgress.color == Color.blue)
    }

    @Test
    func `blocked color is orange`() {
        #expect(PlanDisplayStatus.blocked.color == Color.orange)
    }

    @Test
    func `recentlyDone color is green`() {
        #expect(PlanDisplayStatus.recentlyDone.color == Color.green)
    }

    @Test
    func `done color is gray`() {
        #expect(PlanDisplayStatus.done.color == Color.gray)
    }

    @Test
    func `cancelled color is red`() {
        #expect(PlanDisplayStatus.cancelled.color == Color.red)
    }

    @Test
    func `deferred color is purple`() {
        #expect(PlanDisplayStatus.deferred.color == Color.purple)
    }

    @Test
    func `Each status has a consistent color across multiple calls`() {
        for status in PlanDisplayStatus.allCases {
            #expect(status.color == status.color, "Color not consistent for \(status)")
        }
    }
}

// MARK: - groupPlansByStatus Tests

struct GroupPlansByStatusTests {
    let now = Date()

    // MARK: - Empty and single-status

    @Test
    func `Empty input returns empty array`() {
        let result = groupPlansByStatus([], dependencyStatus: [:], now: now)
        #expect(result.isEmpty)
    }

    @Test
    func `Single-status input returns one group with all plans`() {
        let p1 = makePlan(status: "pending", uuid: "a")
        let p2 = makePlan(status: "pending", uuid: "b")

        let result = groupPlansByStatus([p1, p2], dependencyStatus: [:], now: now)

        #expect(result.count == 1)
        #expect(result[0].status == .pending)
        #expect(result[0].plans.count == 2)
    }

    // MARK: - Group ordering

    @Test
    func `Groups are returned in the defined order: inProgress, pending, blocked, recentlyDone, done, deferred, cancelled`() {
        let sixDaysAgo = self.now.addingTimeInterval(-6 * 24 * 60 * 60)
        let eightDaysAgo = self.now.addingTimeInterval(-8 * 24 * 60 * 60)

        let inProgress = makePlan(status: "in_progress", uuid: "ip")
        let pending = makePlan(status: "pending", uuid: "p")
        let blockedPlan = makePlan(status: "pending", uuid: "bl")
        let recentlyDone = makePlan(status: "done", updatedAt: sixDaysAgo, uuid: "rd")
        let done = makePlan(status: "done", updatedAt: eightDaysAgo, uuid: "d")
        let deferred = makePlan(status: "deferred", uuid: "df")
        let cancelled = makePlan(status: "cancelled", uuid: "c")

        let result = groupPlansByStatus(
            [inProgress, pending, blockedPlan, recentlyDone, done, deferred, cancelled],
            dependencyStatus: ["bl": true],
            now: now)

        #expect(result.count == 7)
        #expect(result[0].status == .inProgress)
        #expect(result[1].status == .pending)
        #expect(result[2].status == .blocked)
        #expect(result[3].status == .recentlyDone)
        #expect(result[4].status == .done)
        #expect(result[5].status == .deferred)
        #expect(result[6].status == .cancelled)
    }

    @Test
    func `Partial statuses appear in correct relative order`() {
        let pending = makePlan(status: "pending", uuid: "p")
        let cancelled = makePlan(status: "cancelled", uuid: "c")

        let result = groupPlansByStatus([cancelled, pending], dependencyStatus: [:], now: now)

        #expect(result.count == 2)
        #expect(result[0].status == .pending)
        #expect(result[1].status == .cancelled)
    }

    // MARK: - Empty groups excluded

    @Test
    func `Empty groups are excluded from result`() {
        let p1 = makePlan(status: "pending", uuid: "a")
        let p2 = makePlan(status: "in_progress", uuid: "b")

        let result = groupPlansByStatus([p1, p2], dependencyStatus: [:], now: now)

        #expect(result.count == 2)
        let statuses = result.map(\.status)
        #expect(statuses.contains(.inProgress))
        #expect(statuses.contains(.pending))
        #expect(!statuses.contains(.blocked))
        #expect(!statuses.contains(.done))
        #expect(!statuses.contains(.recentlyDone))
        #expect(!statuses.contains(.deferred))
        #expect(!statuses.contains(.cancelled))
    }

    // MARK: - Within-group order preserved

    @Test
    func `Within-group order is preserved from input array`() {
        let p1 = makePlan(planId: 10, status: "pending", uuid: "a")
        let p2 = makePlan(planId: 5, status: "pending", uuid: "b")
        let p3 = makePlan(planId: 20, status: "pending", uuid: "c")

        let result = groupPlansByStatus([p1, p2, p3], dependencyStatus: [:], now: now)

        #expect(result.count == 1)
        // Input order preserved: a, b, c (not sorted by planId)
        #expect(result[0].plans.map(\.uuid) == ["a", "b", "c"])
    }

    @Test
    func `Within-group order preserved when plans from multiple statuses are interleaved`() {
        let ip1 = makePlan(status: "in_progress", uuid: "ip1")
        let p1 = makePlan(status: "pending", uuid: "p1")
        let ip2 = makePlan(status: "in_progress", uuid: "ip2")
        let p2 = makePlan(status: "pending", uuid: "p2")

        let result = groupPlansByStatus([ip1, p1, ip2, p2], dependencyStatus: [:], now: now)

        #expect(result.count == 2)
        let inProgressGroup = result.first { $0.status == .inProgress }
        let pendingGroup = result.first { $0.status == .pending }

        // Within-group order matches the original input order
        #expect(inProgressGroup?.plans.map(\.uuid) == ["ip1", "ip2"])
        #expect(pendingGroup?.plans.map(\.uuid) == ["p1", "p2"])
    }

    // MARK: - Blocked status

    @Test
    func `Pending plan with unresolved dependency groups under .blocked`() {
        let blockedPlan = makePlan(status: "pending", uuid: "bl")
        let normalPending = makePlan(status: "pending", uuid: "p")

        let result = groupPlansByStatus(
            [blockedPlan, normalPending],
            dependencyStatus: ["bl": true],
            now: now)

        let statuses = result.map(\.status)
        #expect(statuses.contains(.pending))
        #expect(statuses.contains(.blocked))

        let blockedGroup = result.first { $0.status == .blocked }
        #expect(blockedGroup?.plans.map(\.uuid) == ["bl"])

        let pendingGroup = result.first { $0.status == .pending }
        #expect(pendingGroup?.plans.map(\.uuid) == ["p"])
    }

    @Test
    func `Pending plan with false dependency status is not blocked`() {
        let plan = makePlan(status: "pending", uuid: "p")

        let result = groupPlansByStatus(
            [plan],
            dependencyStatus: ["p": false],
            now: now)

        #expect(result.count == 1)
        #expect(result[0].status == .pending)
    }

    @Test
    func `Pending plan with no dependency entry groups as .pending`() {
        let plan = makePlan(status: "pending", uuid: "p")

        let result = groupPlansByStatus([plan], dependencyStatus: [:], now: now)

        #expect(result.count == 1)
        #expect(result[0].status == .pending)
    }

    // MARK: - recentlyDone vs done

    @Test
    func `Done plan updated within 7 days groups as .recentlyDone`() {
        let sixDaysAgo = self.now.addingTimeInterval(-6 * 24 * 60 * 60)
        let plan = makePlan(status: "done", updatedAt: sixDaysAgo, uuid: "rd")

        let result = groupPlansByStatus([plan], dependencyStatus: [:], now: now)

        #expect(result.count == 1)
        #expect(result[0].status == .recentlyDone)
    }

    @Test
    func `Done plan updated more than 7 days ago groups as .done`() {
        let eightDaysAgo = self.now.addingTimeInterval(-8 * 24 * 60 * 60)
        let plan = makePlan(status: "done", updatedAt: eightDaysAgo, uuid: "d")

        let result = groupPlansByStatus([plan], dependencyStatus: [:], now: now)

        #expect(result.count == 1)
        #expect(result[0].status == .done)
    }

    @Test
    func `Done plan with nil updatedAt groups as .done`() {
        let plan = makePlan(status: "done", updatedAt: nil, uuid: "d")

        let result = groupPlansByStatus([plan], dependencyStatus: [:], now: now)

        #expect(result.count == 1)
        #expect(result[0].status == .done)
    }

    @Test
    func `recentlyDone and done are separate groups when both present`() {
        let sixDaysAgo = self.now.addingTimeInterval(-6 * 24 * 60 * 60)
        let eightDaysAgo = self.now.addingTimeInterval(-8 * 24 * 60 * 60)

        let recentPlan = makePlan(status: "done", updatedAt: sixDaysAgo, uuid: "rd")
        let oldPlan = makePlan(status: "done", updatedAt: eightDaysAgo, uuid: "d")

        let result = groupPlansByStatus([recentPlan, oldPlan], dependencyStatus: [:], now: now)

        #expect(result.count == 2)
        let statuses = result.map(\.status)
        #expect(statuses.contains(.recentlyDone))
        #expect(statuses.contains(.done))
    }

    // MARK: - All 7 statuses

    @Test
    func `All 7 statuses group correctly into distinct groups`() {
        let sixDaysAgo = self.now.addingTimeInterval(-6 * 24 * 60 * 60)
        let eightDaysAgo = self.now.addingTimeInterval(-8 * 24 * 60 * 60)

        let inProgress = makePlan(status: "in_progress", uuid: "ip")
        let pending = makePlan(status: "pending", uuid: "p")
        let blocked = makePlan(status: "pending", uuid: "bl")
        let recentlyDone = makePlan(status: "done", updatedAt: sixDaysAgo, uuid: "rd")
        let done = makePlan(status: "done", updatedAt: eightDaysAgo, uuid: "d")
        let deferred = makePlan(status: "deferred", uuid: "df")
        let cancelled = makePlan(status: "cancelled", uuid: "c")

        let result = groupPlansByStatus(
            [inProgress, pending, blocked, recentlyDone, done, deferred, cancelled],
            dependencyStatus: ["bl": true],
            now: now)

        #expect(result.count == 7)

        let groupedByStatus = Dictionary(uniqueKeysWithValues: result.map { ($0.status, $0) })
        #expect(groupedByStatus[.inProgress]?.plans.map(\.uuid) == ["ip"])
        #expect(groupedByStatus[.pending]?.plans.map(\.uuid) == ["p"])
        #expect(groupedByStatus[.blocked]?.plans.map(\.uuid) == ["bl"])
        #expect(groupedByStatus[.recentlyDone]?.plans.map(\.uuid) == ["rd"])
        #expect(groupedByStatus[.done]?.plans.map(\.uuid) == ["d"])
        #expect(groupedByStatus[.deferred]?.plans.map(\.uuid) == ["df"])
        #expect(groupedByStatus[.cancelled]?.plans.map(\.uuid) == ["c"])
    }

    @Test
    func `Multiple plans in same group are all included`() {
        let p1 = makePlan(status: "in_progress", uuid: "a")
        let p2 = makePlan(status: "in_progress", uuid: "b")
        let p3 = makePlan(status: "in_progress", uuid: "c")

        let result = groupPlansByStatus([p1, p2, p3], dependencyStatus: [:], now: now)

        #expect(result.count == 1)
        #expect(result[0].status == .inProgress)
        #expect(result[0].plans.count == 3)
    }

    @Test
    func `planStatusGroupOrder contains all 7 PlanDisplayStatus cases`() {
        let orderSet = Set(planStatusGroupOrder)
        let allCasesSet = Set(PlanDisplayStatus.allCases)
        #expect(orderSet == allCasesSet)
        #expect(planStatusGroupOrder.count == 7)
    }
}

// MARK: - visiblePlanUuids Tests

struct VisiblePlanUuidsTests {
    @Test
    func `Returns empty array for empty groups`() {
        let result = visiblePlanUuids(from: [])
        #expect(result.isEmpty)
    }

    @Test
    func `Returns UUIDs from a single group in order`() {
        let plans = [
            makePlan(status: "pending", uuid: "a"),
            makePlan(status: "pending", uuid: "b"),
            makePlan(status: "pending", uuid: "c"),
        ]
        let groups = [PlanStatusGroup(status: .pending, plans: plans)]
        let result = visiblePlanUuids(from: groups)
        #expect(result == ["a", "b", "c"])
    }

    @Test
    func `Returns UUIDs from multiple groups preserving group and within-group order`() {
        let group1 = PlanStatusGroup(
            status: .inProgress,
            plans: [makePlan(status: "in_progress", uuid: "ip1"), makePlan(status: "in_progress", uuid: "ip2")])
        let group2 = PlanStatusGroup(
            status: .pending,
            plans: [makePlan(status: "pending", uuid: "p1")])
        let group3 = PlanStatusGroup(
            status: .done,
            plans: [makePlan(status: "done", uuid: "d1"), makePlan(status: "done", uuid: "d2")])

        let result = visiblePlanUuids(from: [group1, group2, group3])
        #expect(result == ["ip1", "ip2", "p1", "d1", "d2"])
    }

    @Test
    func `Groups with no plans contribute nothing`() {
        let group1 = PlanStatusGroup(status: .inProgress, plans: [makePlan(status: "in_progress", uuid: "ip1")])
        let group2 = PlanStatusGroup(status: .pending, plans: [])

        let result = visiblePlanUuids(from: [group1, group2])
        #expect(result == ["ip1"])
    }
}
