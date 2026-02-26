import Foundation
import Observation
import os.log
import SQLite3

// MARK: - LoadState

enum LoadState: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case error(String)
}

// MARK: - StoreError

enum StoreError: LocalizedError, Sendable {
    case noDatabasePath
    case databaseNotFound(String)
    case openFailed(String)
    case queryFailed(String)

    var errorDescription: String? {
        switch self {
        case .noDatabasePath:
            "No tim database path configured"
        case let .databaseNotFound(path):
            "tim database not found at \(path)"
        case let .openFailed(msg):
            "Failed to open tim database: \(msg)"
        case let .queryFailed(msg):
            "Database query failed: \(msg)"
        }
    }
}

// MARK: - SQLite Column Helpers

private func columnText(_ stmt: OpaquePointer, _ col: Int32) -> String? {
    guard sqlite3_column_type(stmt, col) != SQLITE_NULL else { return nil }
    return sqlite3_column_text(stmt, col).map { String(cString: $0) }
}

private func columnInt(_ stmt: OpaquePointer, _ col: Int32) -> Int? {
    guard sqlite3_column_type(stmt, col) != SQLITE_NULL else { return nil }
    return Int(sqlite3_column_int64(stmt, col))
}

private func columnBool(_ stmt: OpaquePointer, _ col: Int32) -> Bool {
    sqlite3_column_int(stmt, col) != 0
}

private let logger = Logger(subsystem: "com.timgui", category: "ProjectTrackingStore")

// MARK: - ISO8601 Date Parsing

private func parseISO8601Date(
    _ str: String?,
    withFractionalSeconds: ISO8601DateFormatter,
    withoutFractionalSeconds: ISO8601DateFormatter) -> Date?
{
    guard let str, !str.isEmpty else { return nil }
    return withFractionalSeconds.date(from: str) ?? withoutFractionalSeconds.date(from: str)
}

// MARK: - SQLite Database Helper

/// Opens a read-only SQLite connection to the given path, runs the operation, then closes.
/// Sets a busy timeout of 5000ms to handle concurrent writer contention gracefully.
private func withSQLiteDB<T>(path: String, operation: (OpaquePointer) throws -> T) throws -> T {
    guard FileManager.default.fileExists(atPath: path) else {
        throw StoreError.databaseNotFound(path)
    }

    var db: OpaquePointer?
    let flags = SQLITE_OPEN_READWRITE
    let rc = sqlite3_open_v2(path, &db, flags, nil)
    guard rc == SQLITE_OK, let db else {
        let msg = db.map { String(cString: sqlite3_errmsg($0)) } ?? "Unknown error"
        let nsPath = path as NSString
        let parentPath = nsPath.deletingLastPathComponent
        let fm = FileManager.default
        logger.error(
            """
            SQLite open failed rc=\(rc, privacy: .public) flags=\(flags, privacy: .public) \
            path=\(path, privacy: .public) exists=\(fm.fileExists(atPath: path), privacy: .public) \
            readable=\(fm.isReadableFile(atPath: path), privacy: .public) \
            parent=\(parentPath, privacy: .public) parent_exists=\(
                fm.fileExists(atPath: parentPath),
                privacy: .public) \
            parent_readable=\(fm.isReadableFile(atPath: parentPath), privacy: .public) \
            parent_writable=\(fm.isWritableFile(atPath: parentPath), privacy: .public) \
            msg=\(msg, privacy: .public)
            """)
        if let db { sqlite3_close(db) }
        throw StoreError.openFailed(msg)
    }
    defer { sqlite3_close(db) }

    // Match tim's DB access assumptions and keep reads cooperative with concurrent writers.
    sqlite3_busy_timeout(db, 5000)
    let lockingRc = sqlite3_exec(db, "PRAGMA locking_mode = NORMAL", nil, nil, nil)
    if lockingRc != SQLITE_OK {
        logger.warning(
            "PRAGMA locking_mode failed rc=\(lockingRc, privacy: .public) path=\(path, privacy: .public) msg=\(String(cString: sqlite3_errmsg(db)), privacy: .public)")
    }
    let queryOnlyRc = sqlite3_exec(db, "PRAGMA query_only = ON", nil, nil, nil)
    if queryOnlyRc != SQLITE_OK {
        logger.warning(
            "PRAGMA query_only failed rc=\(queryOnlyRc, privacy: .public) path=\(path, privacy: .public) msg=\(String(cString: sqlite3_errmsg(db)), privacy: .public)")
    }

    return try operation(db)
}

// MARK: - Background Task Runner

private func runInBackground<T: Sendable>(_ operation: @escaping @Sendable () throws -> T) async throws -> T {
    try await Task.detached(priority: .userInitiated) {
        try operation()
    }.value
}

// MARK: - Database Fetch Functions

private func doFetchProjects(path: String) throws -> [TrackedProject] {
    try withSQLiteDB(path: path) { db in
        let sql = """
        SELECT id, repository_id, remote_url, last_git_root, remote_label
        FROM project
        ORDER BY remote_label, last_git_root, id
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw StoreError.queryFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        var projects: [TrackedProject] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_ROW {
                guard let id = columnText(stmt, 0), !id.isEmpty else { continue }
                projects.append(TrackedProject(
                    id: id,
                    repositoryId: columnText(stmt, 1),
                    remoteUrl: columnText(stmt, 2),
                    lastGitRoot: columnText(stmt, 3),
                    remoteLabel: columnText(stmt, 4)))
                continue
            }
            if rc != SQLITE_DONE {
                throw StoreError.queryFailed("sqlite3_step returned \(rc): \(String(cString: sqlite3_errmsg(db)))")
            }
            break
        }
        return projects
    }
}

private func doFetchWorkspaces(path: String, projectId: String) throws -> [TrackedWorkspace] {
    try withSQLiteDB(path: path) { db in
        let withFractionalSeconds = ISO8601DateFormatter()
        withFractionalSeconds.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let withoutFractionalSeconds = ISO8601DateFormatter()
        withoutFractionalSeconds.formatOptions = [.withInternetDateTime]

        let sql = """
        SELECT w.id, w.project_id, w.workspace_path, w.branch, w.name, w.description,
               w.plan_id, w.plan_title, w.is_primary,
               CASE WHEN wl.workspace_id IS NOT NULL THEN 1 ELSE 0 END AS is_locked,
               w.updated_at
        FROM workspace w
        LEFT JOIN workspace_lock wl ON w.id = wl.workspace_id
        WHERE w.project_id = ?
        ORDER BY w.is_primary DESC, w.name, w.id
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw StoreError.queryFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }

        var workspaces: [TrackedWorkspace] = []
        var stepError: StoreError?
        // withCString keeps the C string alive for the entire binding + stepping scope (SQLITE_STATIC)
        projectId.withCString { cStr in
            sqlite3_bind_text(stmt, 1, cStr, -1, nil)
            while true {
                let rc = sqlite3_step(stmt)
                if rc == SQLITE_ROW {
                    guard let id = columnText(stmt, 0), !id.isEmpty else { continue }
                    let wsProjectId = columnText(stmt, 1) ?? ""
                    workspaces.append(TrackedWorkspace(
                        id: id,
                        projectId: wsProjectId,
                        workspacePath: columnText(stmt, 2),
                        branch: columnText(stmt, 3),
                        name: columnText(stmt, 4),
                        description: columnText(stmt, 5),
                        planId: columnInt(stmt, 6),
                        planTitle: columnText(stmt, 7),
                        isPrimary: columnBool(stmt, 8),
                        isLocked: columnBool(stmt, 9),
                        updatedAt: parseISO8601Date(
                            columnText(stmt, 10),
                            withFractionalSeconds: withFractionalSeconds,
                            withoutFractionalSeconds: withoutFractionalSeconds)))
                    continue
                }
                if rc != SQLITE_DONE {
                    stepError = .queryFailed("sqlite3_step returned \(rc): \(String(cString: sqlite3_errmsg(db)))")
                }
                break
            }
        }
        if let stepError { throw stepError }
        return workspaces
    }
}

private typealias PlansAndDeps = ([TrackedPlan], [String: Bool])

private func doFetchPlansAndDeps(path: String, projectId: String) throws -> PlansAndDeps {
    try withSQLiteDB(path: path) { db in
        let withFractionalSeconds = ISO8601DateFormatter()
        withFractionalSeconds.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let withoutFractionalSeconds = ISO8601DateFormatter()
        withoutFractionalSeconds.formatOptions = [.withInternetDateTime]

        // Fetch plan rows for the project
        let planSQL = """
        SELECT uuid, project_id, plan_id, title, goal, status, priority, parent_uuid,
               epic, filename, created_at, updated_at, branch
        FROM plan
        WHERE project_id = ?
        ORDER BY plan_id DESC, updated_at DESC
        """
        var planStmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, planSQL, -1, &planStmt, nil) == SQLITE_OK, let planStmt else {
            throw StoreError.queryFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(planStmt) }

        var plans: [TrackedPlan] = []
        var planStepError: StoreError?
        projectId.withCString { cStr in
            sqlite3_bind_text(planStmt, 1, cStr, -1, nil)
            while true {
                let rc = sqlite3_step(planStmt)
                if rc == SQLITE_ROW {
                    guard let uuid = columnText(planStmt, 0), !uuid.isEmpty else { continue }
                    let planProjectId = columnText(planStmt, 1) ?? ""
                    let status = columnText(planStmt, 5) ?? "pending"
                    plans.append(TrackedPlan(
                        uuid: uuid,
                        projectId: planProjectId,
                        planId: columnInt(planStmt, 2),
                        title: columnText(planStmt, 3),
                        goal: columnText(planStmt, 4),
                        status: status,
                        priority: columnText(planStmt, 6),
                        parentUuid: columnText(planStmt, 7),
                        isEpic: columnBool(planStmt, 8),
                        filename: columnText(planStmt, 9),
                        createdAt: parseISO8601Date(
                            columnText(planStmt, 10),
                            withFractionalSeconds: withFractionalSeconds,
                            withoutFractionalSeconds: withoutFractionalSeconds),
                        updatedAt: parseISO8601Date(
                            columnText(planStmt, 11),
                            withFractionalSeconds: withFractionalSeconds,
                            withoutFractionalSeconds: withoutFractionalSeconds),
                        branch: columnText(planStmt, 12)))
                    continue
                }
                if rc != SQLITE_DONE {
                    planStepError = .queryFailed("sqlite3_step returned \(rc): \(String(cString: sqlite3_errmsg(db)))")
                }
                break
            }
        }
        if let planStepError { throw planStepError }

        // Fetch dependency status: for each plan in this project, does it have any
        // dependencies whose status is not 'done'?
        let depSQL = """
        SELECT pd.plan_uuid,
               CASE WHEN COUNT(CASE WHEN p2.status != 'done' THEN 1 END) > 0 THEN 1 ELSE 0 END
        FROM plan_dependency pd
        JOIN plan p2 ON pd.depends_on_uuid = p2.uuid
        WHERE pd.plan_uuid IN (SELECT uuid FROM plan WHERE project_id = ?)
        GROUP BY pd.plan_uuid
        """
        var depStmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, depSQL, -1, &depStmt, nil) == SQLITE_OK, let depStmt else {
            throw StoreError.queryFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(depStmt) }

        var depStatus: [String: Bool] = [:]
        var depStepError: StoreError?
        projectId.withCString { cStr in
            sqlite3_bind_text(depStmt, 1, cStr, -1, nil)
            while true {
                let rc = sqlite3_step(depStmt)
                if rc == SQLITE_ROW {
                    guard let planUuid = columnText(depStmt, 0), !planUuid.isEmpty else { continue }
                    depStatus[planUuid] = columnBool(depStmt, 1)
                    continue
                }
                if rc != SQLITE_DONE {
                    depStepError = .queryFailed("sqlite3_step returned \(rc): \(String(cString: sqlite3_errmsg(db)))")
                }
                break
            }
        }
        if let depStepError { throw depStepError }

        return (plans, depStatus)
    }
}

// MARK: - ProjectTrackingStore

@MainActor
@Observable
final class ProjectTrackingStore {
    var projects: [TrackedProject] = []
    var workspaces: [TrackedWorkspace] = []
    var plans: [TrackedPlan] = []
    /// Maps plan UUID → true if the plan has at least one unresolved (non-done) dependency.
    var planDependencyStatus: [String: Bool] = [:]
    var selectedProjectId: String?
    /// Preserved for the upcoming dedicated Plans browser tab.
    /// The current Active Work dashboard does not use user-selectable plan filters.
    var activeFilters: Set<PlanDisplayStatus> = defaultPlanFilters()
    var loadState: LoadState = .idle

    private let dbPath: String?
    var refreshTask: Task<Void, Never>?
    private var refreshConsumerCount: Int = 0
    private var isRefreshing = false
    /// Set to true when `refresh()` is called while a refresh is already in-flight.
    /// The active refresh checks this flag after completing and runs another refresh if needed.
    private var needsRefresh = false

    init(dbPath: String? = nil) {
        self.dbPath = dbPath ?? ProjectTrackingStore.resolveDefaultDBPath()
    }

    // MARK: - DB Path Resolution

    /// Resolves the default tim.db path using the same conventions as the tim CLI
    /// (`getTimConfigRoot()` in `src/common/config_paths.ts`).
    ///
    /// Priority order:
    /// - Windows: `%APPDATA%/tim/{filename}` (falling back to `~/AppData/Roaming/tim`)
    /// - macOS/Linux: `$XDG_CONFIG_HOME/tim/{filename}` if set and non-empty (trimmed)
    /// - macOS/Linux fallback: `~/.config/tim/{filename}`
    ///
    /// The filename is controlled by the `TIM_DATABASE_FILENAME` environment variable,
    /// defaulting to `tim.db` when unset.
    static func resolveDefaultDBPath() -> String? {
        let env = ProcessInfo.processInfo.environment
        let dbFileName = env["TIM_DATABASE_FILENAME"] ?? "tim.db"
        #if os(Windows)
        let appData =
            env["APPDATA"]
                ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("AppData")
                .appendingPathComponent("Roaming").path
        return URL(fileURLWithPath: appData)
            .appendingPathComponent("tim")
            .appendingPathComponent(dbFileName).path
        #else
        let xdgConfigHome = env["XDG_CONFIG_HOME"]?.trimmingCharacters(in: .whitespaces)
        if let xdg = xdgConfigHome, !xdg.isEmpty {
            let resolved = URL(fileURLWithPath: xdg)
                .appendingPathComponent("tim")
                .appendingPathComponent(dbFileName).path
            logger.debug("Resolved DB path using XDG_CONFIG_HOME: \(resolved, privacy: .public)")
            return resolved
        }
        let resolved = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config")
            .appendingPathComponent("tim")
            .appendingPathComponent(dbFileName).path
        logger.debug("Resolved DB path using HOME fallback: \(resolved, privacy: .public)")
        return resolved
        #endif
    }

    // MARK: - Refresh Lifecycle

    /// Starts an initial load and begins periodic background refresh every 10 seconds.
    /// Reference-counted: multiple consumers can safely call start/stop independently.
    /// The refresh loop runs as long as at least one consumer is active.
    func startRefreshing() {
        self.refreshConsumerCount += 1
        guard self.refreshConsumerCount == 1 else { return }
        self.refreshTask?.cancel()
        self.refreshTask = Task {
            await self.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                if !Task.isCancelled {
                    await self.refresh()
                }
            }
        }
    }

    /// Decrements the refresh consumer count and cancels the periodic refresh loop
    /// when no consumers remain.
    func stopRefreshing() {
        self.refreshConsumerCount = max(0, self.refreshConsumerCount - 1)
        guard self.refreshConsumerCount == 0 else { return }
        self.refreshTask?.cancel()
        self.refreshTask = nil
    }

    /// Selects a project and triggers a data reload.
    func selectProject(id: String?) {
        self.selectedProjectId = id
        Task { await self.refresh() }
    }

    // MARK: - Data Loading

    /// Reloads all data from the database.
    ///
    /// If called while a refresh is already in-flight, sets `needsRefresh = true` so the
    /// active refresh performs a follow-up pass after completing — preventing stale data
    /// when the selected project changes mid-flight.
    ///
    /// Before assigning project-specific data (workspaces, plans), validates that
    /// `selectedProjectId` still matches the project captured at the start of the fetch.
    /// If the selection changed mid-fetch, the data is discarded and the follow-up refresh
    /// loads the correct project's data.
    func refresh() async {
        if self.isRefreshing {
            self.needsRefresh = true
            return
        }

        self.isRefreshing = true
        defer { self.isRefreshing = false }

        while true {
            self.needsRefresh = false
            let capturedProjectId = self.selectedProjectId

            self.loadState = .loading

            guard let path = dbPath else {
                logger.error("Refresh aborted: no database path configured")
                self.loadState = .error("No tim database path configured")
                break
            }

            do {
                let fetchedProjects = try await runInBackground { try doFetchProjects(path: path) }
                self.projects = fetchedProjects

                if let projectId = capturedProjectId {
                    let fetchedWorkspaces = try await runInBackground {
                        try doFetchWorkspaces(path: path, projectId: projectId)
                    }
                    // Only commit if the selection hasn't changed since we started fetching
                    if self.selectedProjectId == capturedProjectId {
                        self.workspaces = fetchedWorkspaces

                        let (fetchedPlans, fetchedDeps) = try await runInBackground {
                            try doFetchPlansAndDeps(path: path, projectId: projectId)
                        }
                        if self.selectedProjectId == capturedProjectId {
                            self.plans = fetchedPlans
                            self.planDependencyStatus = fetchedDeps
                        }
                    }
                } else {
                    self.workspaces = []
                    self.plans = []
                    self.planDependencyStatus = [:]
                }

                self.loadState = .loaded
            } catch {
                let selected = capturedProjectId ?? "<none>"
                logger.error(
                    "Refresh failed path=\(path, privacy: .public) selectedProjectId=\(selected, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
                self.loadState = .error(error.localizedDescription)
            }

            if !self.needsRefresh { break }
        }
    }

    // MARK: - Computed Helpers

    /// Returns the subset of plans that pass the current active filters.
    /// This is currently used by tests and reserved for the future Plans browser tab.
    func filteredPlans(now: Date = Date()) -> [TrackedPlan] {
        self.plans.filter { plan in
            let hasUnresolved = self.planDependencyStatus[plan.uuid] ?? false
            let status = planDisplayStatus(for: plan, hasUnresolvedDependencies: hasUnresolved, now: now)
            return shouldShowPlan(displayStatus: status, activeFilters: self.activeFilters)
        }
    }

    /// Returns the derived display status for a single plan.
    func displayStatus(for plan: TrackedPlan, now: Date = Date()) -> PlanDisplayStatus {
        planDisplayStatus(
            for: plan,
            hasUnresolvedDependencies: self.planDependencyStatus[plan.uuid] ?? false,
            now: now)
    }
}
