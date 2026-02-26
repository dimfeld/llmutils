import Foundation
import SQLite3
import Testing
@testable import TimGUI

// MARK: - Test Database Helpers

private func isoDateString(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.string(from: date)
}

/// Creates a temporary SQLite database at `path` with the tim schema tables.
///
/// Schema matches the production tim.db schema:
/// - project.id and workspace.id use INTEGER PRIMARY KEY AUTOINCREMENT (not TEXT)
/// - plan.plan_id and plan.filename are NOT NULL (with defaults for test convenience)
/// - workspace_lock includes all required NOT NULL columns
private func createTestDatabase(at path: String) throws {
    var db: OpaquePointer?
    let rc = sqlite3_open(path, &db)
    guard rc == SQLITE_OK, let db else {
        let code = Int(rc)
        sqlite3_close(db)
        throw NSError(
            domain: "TestDB",
            code: code,
            userInfo: [NSLocalizedDescriptionKey: "Failed to create test DB at \(path)"])
    }
    defer { sqlite3_close(db) }

    // Schema matches production tim.db:
    // - project.id: INTEGER PRIMARY KEY AUTOINCREMENT (not TEXT)
    // - workspace.id: INTEGER PRIMARY KEY AUTOINCREMENT (not TEXT)
    // - project.repository_id: TEXT NOT NULL UNIQUE
    // - workspace.workspace_path: TEXT NOT NULL UNIQUE
    // - plan.plan_id: INTEGER NOT NULL (DEFAULT 0 for test convenience)
    // - plan.filename: TEXT NOT NULL (DEFAULT 'plan.md' for test convenience)
    // - workspace_lock: includes all required NOT NULL columns
    //
    // Note: Swift model reads integer IDs via columnText(), which returns their string
    // representation (e.g. 1 → "1"). bind_text with "1" compares correctly against
    // INTEGER columns via SQLite's numeric affinity coercion.
    let schema = """
    CREATE TABLE project (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository_id TEXT NOT NULL UNIQUE,
        remote_url TEXT,
        last_git_root TEXT,
        remote_label TEXT
    );
    CREATE TABLE workspace (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES project(id),
        workspace_path TEXT NOT NULL UNIQUE,
        branch TEXT,
        name TEXT,
        description TEXT,
        plan_id INTEGER,
        plan_title TEXT,
        is_primary INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE workspace_lock (
        workspace_id INTEGER PRIMARY KEY NOT NULL REFERENCES workspace(id),
        lock_type TEXT NOT NULL,
        pid INTEGER,
        started_at TEXT NOT NULL,
        hostname TEXT NOT NULL,
        command TEXT NOT NULL
    );
    CREATE TABLE plan (
        uuid TEXT PRIMARY KEY NOT NULL,
        project_id INTEGER NOT NULL REFERENCES project(id),
        plan_id INTEGER NOT NULL DEFAULT 0,
        title TEXT,
        goal TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT,
        parent_uuid TEXT,
        epic INTEGER NOT NULL DEFAULT 0,
        filename TEXT NOT NULL DEFAULT 'plan.md',
        created_at TEXT,
        updated_at TEXT,
        branch TEXT
    );
    CREATE TABLE plan_dependency (
        plan_uuid TEXT NOT NULL REFERENCES plan(uuid),
        depends_on_uuid TEXT NOT NULL REFERENCES plan(uuid),
        PRIMARY KEY (plan_uuid, depends_on_uuid)
    );
    """

    var errMsg: UnsafeMutablePointer<CChar>?
    let execRc = sqlite3_exec(db, schema, nil, nil, &errMsg)
    if execRc != SQLITE_OK {
        let msg = errMsg.map { String(cString: $0) } ?? "Unknown schema error"
        sqlite3_free(errMsg)
        throw NSError(
            domain: "TestDB",
            code: Int(execRc),
            userInfo: [NSLocalizedDescriptionKey: "Schema creation failed: \(msg)"])
    }
}

/// Executes a single SQL statement on the given DB, ignoring errors (for test setup convenience).
private func execSQL(_ db: OpaquePointer, _ sql: String) {
    var errMsg: UnsafeMutablePointer<CChar>?
    let rc = sqlite3_exec(db, sql, nil, nil, &errMsg)
    if rc != SQLITE_OK {
        let msg = errMsg.map { String(cString: $0) } ?? "Unknown error"
        sqlite3_free(errMsg)
        // In tests, surface setup failures as precondition failures
        preconditionFailure("Test DB setup SQL failed (\(rc)): \(msg)\nSQL: \(sql)")
    }
}

/// Opens a writable connection to `path`, runs `body`, then closes the connection.
private func withTestDB(path: String, body: (OpaquePointer) -> Void) {
    var db: OpaquePointer?
    guard sqlite3_open(path, &db) == SQLITE_OK, let db else { return }
    defer { sqlite3_close(db) }
    body(db)
}

/// Returns the root B-tree page number (1-based) for a named table in the given open DB connection.
/// Queries sqlite_master, which is always on page 1 and is not affected by data-page corruption.
private func getTableRootPage(_ db: OpaquePointer, tableName: String) -> Int? {
    var stmt: OpaquePointer?
    let sql = "SELECT rootpage FROM sqlite_master WHERE type='table' AND name=?"
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { return nil }
    defer { sqlite3_finalize(stmt) }
    var result: Int?
    tableName.withCString { cStr in
        sqlite3_bind_text(stmt, 1, cStr, -1, nil)
        if sqlite3_step(stmt) == SQLITE_ROW {
            result = Int(sqlite3_column_int(stmt, 0))
        }
    }
    return result
}

// MARK: - ProjectTrackingStoreTests

@Suite("ProjectTrackingStore", .serialized)
@MainActor
struct ProjectTrackingStoreTests {
    // MARK: - Fixture Setup

    private func makeTestDBPath() throws -> (path: String, cleanup: () -> Void) {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("TimGUI-StoreTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        let dbPath = tmpDir.appendingPathComponent("test.db").path
        try createTestDatabase(at: dbPath)
        let cleanup: () -> Void = { do { try FileManager.default.removeItem(at: tmpDir) } catch {} }
        return (dbPath, cleanup)
    }

    // MARK: - Project Loading

    @Test("Loads projects from DB")
    func loadsProjects() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (1, 'repo-1', 'Alpha Project')")
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (2, 'repo-2', 'Beta Project')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        await store.refresh()

        #expect(store.loadState == .loaded)
        #expect(store.projects.count == 2)
        let labels = Set(store.projects.map(\.displayName))
        #expect(labels.contains("Alpha Project"))
        #expect(labels.contains("Beta Project"))
    }

    @Test("Returns empty project list for empty DB")
    func emptyDB() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        let store = ProjectTrackingStore(dbPath: path)
        await store.refresh()

        #expect(store.loadState == .loaded)
        #expect(store.projects.isEmpty)
    }

    @Test("Missing DB file produces error state")
    func missingDBFile() async {
        let nonExistentPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("no-such-\(UUID().uuidString).db").path

        let store = ProjectTrackingStore(dbPath: nonExistentPath)
        await store.refresh()

        guard case .error = store.loadState else {
            Issue.record("Expected .error load state, got \(store.loadState)")
            return
        }
    }

    @Test("Projects have correct field mapping from DB")
    func projectFieldMapping() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, """
            INSERT INTO project (id, repository_id, remote_url, last_git_root, remote_label)
            VALUES (1, 'repo-xyz', 'https://github.com/user/myrepo', '/home/user/myrepo', 'My Repo')
            """)
        }

        let store = ProjectTrackingStore(dbPath: path)
        await store.refresh()

        let project = try #require(store.projects.first)
        #expect(project.id == "1")
        #expect(project.repositoryId == "repo-xyz")
        #expect(project.remoteUrl == "https://github.com/user/myrepo")
        #expect(project.lastGitRoot == "/home/user/myrepo")
        #expect(project.remoteLabel == "My Repo")
        #expect(project.displayName == "My Repo")
    }

    // MARK: - Workspace Loading

    @Test("Loads workspaces for selected project")
    func loadsWorkspaces() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (1, 1, '/tmp/workspace-1', 'Workspace A', 0)")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (2, 1, '/tmp/workspace-2', 'Workspace B', 1)")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        #expect(store.workspaces.count == 2)
        let names = Set(store.workspaces.map(\.displayName))
        #expect(names.contains("Workspace A"))
        #expect(names.contains("Workspace B"))
    }

    @Test("Detects locked workspaces via workspace_lock join")
    func detectsLockedWorkspaces() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (1, 1, '/tmp/workspace-1', 'Locked WS', 0)")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (2, 1, '/tmp/workspace-2', 'Free WS', 0)")
            execSQL(
                db,
                "INSERT INTO workspace_lock (workspace_id, lock_type, started_at, hostname, command) VALUES (1, 'exclusive', '2024-01-01T00:00:00Z', 'test-host', 'test-command')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        #expect(store.workspaces.count == 2)
        let locked = store.workspaces.first { $0.id == "1" }
        let free = store.workspaces.first { $0.id == "2" }
        #expect(locked?.isLocked == true)
        #expect(locked?.displayStatus == .locked)
        #expect(free?.isLocked == false)
        #expect(free?.displayStatus == .available)
    }

    @Test("Primary workspace has correct display status")
    func primaryWorkspaceStatus() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (1, 1, '/tmp/workspace-1', 'Main WS', 1)")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (2, 1, '/tmp/workspace-2', 'Other WS', 0)")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let primary = store.workspaces.first { $0.id == "1" }
        let regular = store.workspaces.first { $0.id == "2" }
        #expect(primary?.isPrimary == true)
        #expect(primary?.displayStatus == .primary)
        #expect(regular?.isPrimary == false)
        #expect(regular?.displayStatus == .available)
    }

    @Test("Returns empty workspaces for project with no workspaces")
    func emptyWorkspacesForProject() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        #expect(store.workspaces.isEmpty)
    }

    @Test("Workspaces for other projects are not loaded")
    func workspacesIsolatedByProject() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (2, 'repo-2')")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (1, 1, '/tmp/workspace-1', 'WS for proj1', 0)")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (2, 2, '/tmp/workspace-2', 'WS for proj2', 0)")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        #expect(store.workspaces.count == 1)
        #expect(store.workspaces.first?.id == "1")
    }

    @Test("Workspace updated_at is parsed from DB")
    func workspaceUpdatedAtParsed() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary, updated_at) VALUES (1, 1, '/tmp/workspace-1', 'WS1', 0, '2026-02-24T10:30:00Z')")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary, updated_at) VALUES (2, 1, '/tmp/workspace-2', 'WS2', 0, '2026-02-25T08:00:00.123Z')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        #expect(store.workspaces.count == 2)
        let ws1 = store.workspaces.first { $0.id == "1" }
        let ws2 = store.workspaces.first { $0.id == "2" }
        #expect(ws1?.updatedAt != nil)
        #expect(ws2?.updatedAt != nil)
    }

    @Test("Workspace uses DB default updated_at when not explicitly set")
    func workspaceDefaultUpdatedAt() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (1, 1, '/tmp/workspace-1', 'WS1', 0)")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        #expect(store.workspaces.count == 1)
        // The DB default generates the current timestamp, so updatedAt should be non-nil
        #expect(store.workspaces.first?.updatedAt != nil)
    }

    // MARK: - Plan Loading

    @Test("Loads plans for selected project")
    func loadsPlans() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, title, status) VALUES ('uuid-1', 1, 101, 'First Plan', 'pending')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, title, status) VALUES ('uuid-2', 1, 102, 'Second Plan', 'in_progress')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        #expect(store.plans.count == 2)
        let uuids = Set(store.plans.map(\.uuid))
        #expect(uuids.contains("uuid-1"))
        #expect(uuids.contains("uuid-2"))
    }

    @Test("Plans ordered by plan_id descending")
    func plansOrderedByPlanIdDesc() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('low-id', 1, 10, 'pending')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('high-id', 1, 99, 'pending')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('mid-id', 1, 50, 'pending')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        #expect(store.plans.count == 3)
        #expect(store.plans[0].uuid == "high-id") // plan_id 99
        #expect(store.plans[1].uuid == "mid-id") // plan_id 50
        #expect(store.plans[2].uuid == "low-id") // plan_id 10
    }

    @Test("Plans for other projects are not loaded")
    func plansIsolatedByProject() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (2, 'repo-2')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('p1', 1, 1, 'pending')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('p2', 2, 2, 'pending')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        #expect(store.plans.count == 1)
        #expect(store.plans.first?.uuid == "p1")
    }

    @Test("Plan date fields parsed from ISO 8601 strings")
    func planDateFieldsParsed() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        let now = Date()
        let createdStr = isoDateString(now.addingTimeInterval(-3600))
        let updatedStr = isoDateString(now)

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, """
            INSERT INTO plan (uuid, project_id, plan_id, status, created_at, updated_at)
            VALUES ('p1', 1, 1, 'done', '\(createdStr)', '\(updatedStr)')
            """)
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let plan = try #require(store.plans.first)
        #expect(plan.createdAt != nil)
        #expect(plan.updatedAt != nil)
        // Verify the parsed date is within 2 seconds of what we inserted
        let updatedDiff = abs((plan.updatedAt ?? Date.distantPast).timeIntervalSince(now))
        #expect(updatedDiff < 2)
    }

    // MARK: - Dependency Status

    @Test("Plan with all deps done → hasUnresolvedDependencies = false")
    func allDepsDone() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('plan-a', 1, 1, 'pending')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('dep-1', 1, 2, 'done')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('dep-2', 1, 3, 'done')")
            execSQL(db, "INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES ('plan-a', 'dep-1')")
            execSQL(db, "INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES ('plan-a', 'dep-2')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let hasUnresolved = store.planDependencyStatus["plan-a"] ?? false
        #expect(hasUnresolved == false)
    }

    @Test("Plan with at least one non-done dep → hasUnresolvedDependencies = true")
    func hasUnresolvedDep() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('plan-a', 1, 1, 'pending')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('dep-done', 1, 2, 'done')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('dep-pending', 1, 3, 'pending')")
            execSQL(db, "INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES ('plan-a', 'dep-done')")
            execSQL(db, "INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES ('plan-a', 'dep-pending')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let hasUnresolved = store.planDependencyStatus["plan-a"] ?? false
        #expect(hasUnresolved == true)
    }

    @Test("Plan with in_progress dep → hasUnresolvedDependencies = true")
    func inProgressDepIsUnresolved() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('plan-a', 1, 1, 'pending')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('dep-in-progress', 1, 2, 'in_progress')")
            execSQL(db, "INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES ('plan-a', 'dep-in-progress')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let hasUnresolved = store.planDependencyStatus["plan-a"] ?? false
        #expect(hasUnresolved == true)
    }

    @Test("Plan with no deps → not in dependency map (defaults to false)")
    func noDepsNotInMap() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('plan-no-deps', 1, 1, 'pending')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        // Plan with no dependencies should not appear in the dependency map
        #expect(store.planDependencyStatus["plan-no-deps"] == nil)
        // And the derived value defaults to false
        #expect((store.planDependencyStatus["plan-no-deps"] ?? false) == false)
    }

    // MARK: - Filter Integration

    @Test("filteredPlans with default filters shows pending and in_progress, hides old done/cancelled/deferred")
    func filteredPlansDefaultFilters() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        let now = Date()
        let recentISO = isoDateString(now.addingTimeInterval(-2 * 24 * 60 * 60))
        let oldISO = isoDateString(now.addingTimeInterval(-10 * 24 * 60 * 60))

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('pending-plan', 1, 1, 'pending')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('inprogress-plan', 1, 2, 'in_progress')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status, updated_at) VALUES ('recent-done', 1, 3, 'done', '\(recentISO)')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status, updated_at) VALUES ('old-done', 1, 4, 'done', '\(oldISO)')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('cancelled-plan', 1, 5, 'cancelled')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('deferred-plan', 1, 6, 'deferred')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        // Default filters: pending, inProgress, blocked, recentlyDone
        let filtered = store.filteredPlans(now: now)
        let uuids = Set(filtered.map(\.uuid))

        #expect(uuids.contains("pending-plan"))
        #expect(uuids.contains("inprogress-plan"))
        #expect(uuids.contains("recent-done"))
        #expect(!uuids.contains("old-done"))
        #expect(!uuids.contains("cancelled-plan"))
        #expect(!uuids.contains("deferred-plan"))
    }

    @Test("filteredPlans shows blocked plans (pending with unresolved deps)")
    func filteredPlansShowsBlockedPlans() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('blocker', 1, 1, 'pending')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('blocked-plan', 1, 2, 'pending')")
            execSQL(db, "INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES ('blocked-plan', 'blocker')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let now = Date()
        let filtered = store.filteredPlans(now: now)
        let uuids = Set(filtered.map(\.uuid))

        // Both 'blocker' (pending, no unresolved deps) and 'blocked-plan' (blocked) should appear
        #expect(uuids.contains("blocker"))
        #expect(uuids.contains("blocked-plan"))
    }

    @Test("filteredPlans with all statuses shows everything including old done and cancelled")
    func filteredPlansAllFilters() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        let oldISO = isoDateString(Date().addingTimeInterval(-10 * 24 * 60 * 60))

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('pending-plan', 1, 1, 'pending')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status, updated_at) VALUES ('old-done', 1, 2, 'done', '\(oldISO)')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('cancelled-plan', 1, 3, 'cancelled')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('deferred-plan', 1, 4, 'deferred')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        store.activeFilters = Set(PlanDisplayStatus.allCases)
        await store.refresh()

        let filtered = store.filteredPlans(now: Date())
        #expect(filtered.count == 4)
    }

    @Test("filteredPlans with empty filter hides everything")
    func filteredPlansEmptyFilterHidesAll() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('p1', 1, 1, 'pending')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('p2', 1, 2, 'in_progress')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        store.activeFilters = []
        await store.refresh()

        #expect(store.filteredPlans(now: Date()).isEmpty)
    }

    // MARK: - No Selected Project

    @Test("No selected project results in empty workspaces and plans")
    func noSelectedProjectEmptyData() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('p1', 1, 1, 'pending')")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, is_primary) VALUES (1, 1, '/tmp/workspace-1', 0)")
        }

        let store = ProjectTrackingStore(dbPath: path)
        // Do NOT set selectedProjectId
        await store.refresh()

        #expect(store.loadState == .loaded)
        #expect(!store.projects.isEmpty) // projects should still load
        #expect(store.workspaces.isEmpty) // but no project is selected
        #expect(store.plans.isEmpty)
        #expect(store.planDependencyStatus.isEmpty)
    }

    // MARK: - State Management

    @Test("Load state transitions: idle → loading → loaded")
    func loadStateTransitions() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        let store = ProjectTrackingStore(dbPath: path)
        #expect(store.loadState == .idle)

        await store.refresh()

        #expect(store.loadState == .loaded)
    }

    @Test("Default active filters match defaultPlanFilters()")
    func defaultActiveFiltersMatchHelper() throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        let store = ProjectTrackingStore(dbPath: path)
        #expect(store.activeFilters == defaultPlanFilters())
    }

    // MARK: - Malformed Row Handling

    @Test("Workspace with null optional fields loads successfully")
    func workspaceWithNullOptionalFieldsLoads() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            // Workspace with only required fields (name, branch, etc. are NULL)
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, is_primary) VALUES (1, 1, '/tmp/workspace-1', 0)")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (2, 1, '/tmp/workspace-2', 'Named WS', 0)")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        // Both workspaces should load, even the one with NULL optional fields
        #expect(store.workspaces.count == 2)
        let named = store.workspaces.first { $0.name != nil }
        #expect(named?.name == "Named WS")
    }

    @Test("Plan with empty uuid is skipped, subsequent plans still loaded")
    func planWithEmptyUuidIsSkipped() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            // Empty string uuid — sorted first by plan_id ASC in the while loop, but we insert
            // with plan_id=1 so it comes second when ordered by plan_id DESC
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('valid-uuid', 1, 2, 'pending')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('', 1, 1, 'pending')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        // valid-uuid (plan_id=2) comes first in DESC order; empty-uuid (plan_id=1) is second and skipped
        #expect(store.plans.count == 1)
        #expect(store.plans.first?.uuid == "valid-uuid")
    }

    @Test("Corrupted (non-SQLite) DB file produces error state")
    func corruptedDBFileProducesErrorState() async throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("TimGUI-CorruptDB-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        let corruptPath = tmpDir.appendingPathComponent("corrupt.db").path
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        // Write non-SQLite content to the path — the file exists but is not a valid SQLite DB
        try "this is not a sqlite database".write(toFile: corruptPath, atomically: true, encoding: .utf8)

        let store = ProjectTrackingStore(dbPath: corruptPath)
        await store.refresh()

        guard case .error = store.loadState else {
            Issue.record("Expected .error load state for corrupted DB, got \(store.loadState)")
            return
        }
    }

    @Test("Corrupt data pages cause sqlite3_step to fail with error state, not silently return partial data")
    func corruptDataPagesProduceErrorStateViaSqliteStep() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        // Insert a project row so the project table has data.
        // The schema occupies several root pages (one per table), so the file has multiple pages
        // and the project table root page is NOT in page 1 (which holds sqlite_master).
        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (1, 'repo-1', 'Alpha')")
        }

        // Read the file and corrupt all pages beyond page 1.
        // Page 1 holds the SQLite header + sqlite_master (schema intact → sqlite3_prepare_v2 succeeds).
        // Pages 2+ hold user table root pages (corrupted → sqlite3_step returns SQLITE_CORRUPT).
        // This specifically tests the sqlite3_step return-code validation added in Task 14:
        // the old code would silently return an empty array; the new code throws StoreError.queryFailed.
        var fileData = try Data(contentsOf: URL(fileURLWithPath: path))
        // Page size is encoded big-endian in bytes 16–17 of the file header.
        // A stored value of 1 is a special encoding for 65536 per the SQLite spec.
        let rawPageSize = fileData.count >= 18 ? Int(fileData[16]) << 8 | Int(fileData[17]) : 4096
        let pageSize = rawPageSize == 1 ? 65536 : rawPageSize

        guard fileData.count > pageSize else {
            // The DB should always span multiple pages with our schema (5 tables + data).
            // If it fits in a single page, the test cannot isolate data pages and must fail.
            Issue.record(
                "DB file (\(fileData.count) bytes) fits within one page (\(pageSize) bytes); expected multiple pages with 5-table schema")
            return
        }

        // Overwrite bytes from page 2 onwards with 0xFF to corrupt user table pages.
        fileData.replaceSubrange(pageSize..., with: Data(repeating: 0xFF, count: fileData.count - pageSize))
        try fileData.write(to: URL(fileURLWithPath: path))

        let store = ProjectTrackingStore(dbPath: path)
        await store.refresh()

        guard case .error = store.loadState else {
            Issue.record(
                "Expected .error load state when sqlite3_step fails on corrupt data page, got \(store.loadState)")
            return
        }
    }

    @Test(
        "Corrupt workspace pages cause doFetchWorkspaces sqlite3_step to fail with error state when selectedProjectId is set")
    func workspaceStepErrorProducesErrorState() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        // Insert a valid project row so doFetchProjects succeeds.
        // No workspace rows are inserted so the workspace B-tree root page is empty
        // (SQLITE_DONE returned immediately on first step — unless the page is corrupted).
        var projectRootPage: Int?
        var workspaceRootPage: Int?
        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (1, 'repo-1', 'Alpha')")
            projectRootPage = getTableRootPage(db, tableName: "project")
            workspaceRootPage = getTableRootPage(db, tableName: "workspace")
        }

        let projRoot = try #require(projectRootPage, "Could not read project root page from sqlite_master")
        let wsRoot = try #require(workspaceRootPage, "Could not read workspace root page from sqlite_master")

        // The workspace root page must come after the project root page so we can corrupt
        // workspace pages without affecting the project B-tree (which doFetchProjects reads).
        guard wsRoot > projRoot else {
            Issue.record(
                "Workspace root page (\(wsRoot)) is not after project root page (\(projRoot)); cannot selectively corrupt workspace pages without also corrupting project")
            return
        }

        var fileData = try Data(contentsOf: URL(fileURLWithPath: path))
        let rawPageSize = fileData.count >= 18 ? Int(fileData[16]) << 8 | Int(fileData[17]) : 4096
        let pageSize = rawPageSize == 1 ? 65536 : rawPageSize
        let corruptOffset = (wsRoot - 1) * pageSize

        guard corruptOffset < fileData.count else {
            Issue.record(
                "Workspace root page (\(wsRoot)) byte offset \(corruptOffset) is beyond file size \(fileData.count)")
            return
        }

        // Overwrite the workspace root page and everything beyond it with 0xFF.
        // Page 1 (sqlite_master) stays intact → sqlite3_prepare_v2 succeeds for all queries.
        // Project root page stays intact → doFetchProjects reads its rows and returns successfully.
        // Workspace root page and beyond are corrupted → sqlite3_step for the workspace query
        // returns SQLITE_CORRUPT, exercising the doFetchWorkspaces step-error validation path.
        fileData.replaceSubrange(
            corruptOffset...,
            with: Data(repeating: 0xFF, count: fileData.count - corruptOffset))
        try fileData.write(to: URL(fileURLWithPath: path))

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        guard case .error = store.loadState else {
            Issue.record(
                "Expected .error load state when doFetchWorkspaces sqlite3_step fails on corrupt page, got \(store.loadState)")
            return
        }
    }

    @Test(
        "Corrupt plan pages cause doFetchPlansAndDeps sqlite3_step to fail with error state when selectedProjectId is set")
    func plansStepErrorProducesErrorState() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        // Insert a valid project row so doFetchProjects succeeds.
        // No workspace or plan rows are inserted so:
        //   - doFetchWorkspaces reads the (intact) workspace root and returns SQLITE_DONE immediately.
        //   - doFetchPlansAndDeps tries to read the (corrupted) plan root and gets SQLITE_CORRUPT.
        var workspaceRootPage: Int?
        var planRootPage: Int?
        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (1, 'repo-1', 'Alpha')")
            workspaceRootPage = getTableRootPage(db, tableName: "workspace")
            planRootPage = getTableRootPage(db, tableName: "plan")
        }

        let wsRoot = try #require(workspaceRootPage, "Could not read workspace root page from sqlite_master")
        let planRoot = try #require(planRootPage, "Could not read plan root page from sqlite_master")

        // The plan root page must come after the workspace root page so we can corrupt the plan
        // pages without affecting the workspace B-tree (which doFetchWorkspaces reads first).
        guard planRoot > wsRoot else {
            Issue.record(
                "Plan root page (\(planRoot)) is not after workspace root page (\(wsRoot)); cannot selectively corrupt plan pages without also corrupting workspace")
            return
        }

        var fileData = try Data(contentsOf: URL(fileURLWithPath: path))
        let rawPageSize = fileData.count >= 18 ? Int(fileData[16]) << 8 | Int(fileData[17]) : 4096
        let pageSize = rawPageSize == 1 ? 65536 : rawPageSize
        let corruptOffset = (planRoot - 1) * pageSize

        guard corruptOffset < fileData.count else {
            Issue.record(
                "Plan root page (\(planRoot)) byte offset \(corruptOffset) is beyond file size \(fileData.count)")
            return
        }

        // Overwrite the plan root page and everything beyond it with 0xFF.
        // Page 1 (sqlite_master) stays intact → sqlite3_prepare_v2 succeeds for all queries.
        // Project and workspace root pages stay intact → doFetchProjects and doFetchWorkspaces succeed.
        // Plan root page is corrupted → sqlite3_step for the plan query returns SQLITE_CORRUPT,
        // exercising the doFetchPlansAndDeps step-error validation path.
        fileData.replaceSubrange(
            corruptOffset...,
            with: Data(repeating: 0xFF, count: fileData.count - corruptOffset))
        try fileData.write(to: URL(fileURLWithPath: path))

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        guard case .error = store.loadState else {
            Issue.record(
                "Expected .error load state when doFetchPlansAndDeps sqlite3_step fails on corrupt page, got \(store.loadState)")
            return
        }
    }

    // MARK: - displayStatus Helper

    @Test("displayStatus helper returns correct status using stored dependency info")
    func displayStatusHelper() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('blocker', 1, 1, 'pending')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('blocked', 1, 2, 'pending')")
            execSQL(db, "INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES ('blocked', 'blocker')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let now = Date()
        let blockerPlan = try #require(store.plans.first { $0.uuid == "blocker" })
        let blockedPlan = try #require(store.plans.first { $0.uuid == "blocked" })

        // 'blocker' has no unresolved deps → pending
        #expect(store.displayStatus(for: blockerPlan, now: now) == .pending)
        // 'blocked' has unresolved dep on 'blocker' (which is pending) → blocked
        #expect(store.displayStatus(for: blockedPlan, now: now) == .blocked)
    }

    // MARK: - View State Tests

    @Test("Error state from missing DB contains a non-empty message")
    func errorStateContainsNonEmptyMessage() async {
        let nonExistentPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("no-such-\(UUID().uuidString).db").path

        let store = ProjectTrackingStore(dbPath: nonExistentPath)
        await store.refresh()

        if case let .error(message) = store.loadState {
            #expect(!message.isEmpty)
        } else {
            Issue.record("Expected .error load state, got \(store.loadState)")
        }
    }

    @Test("Filter toggle: removing a filter hides matching plans, re-adding restores them")
    func filterToggleRemoveAndRestore() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('pending-1', 1, 1, 'pending')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('inprogress-1', 1, 2, 'in_progress')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let now = Date()

        // Default: both pending and in_progress are visible
        let allVisible = store.filteredPlans(now: now)
        #expect(allVisible.count == 2)

        // Remove inProgress filter → only pending remains
        store.activeFilters.remove(.inProgress)
        let withoutInProgress = store.filteredPlans(now: now)
        #expect(withoutInProgress.count == 1)
        #expect(withoutInProgress.first?.uuid == "pending-1")

        // Restore inProgress filter → both visible again
        store.activeFilters.insert(.inProgress)
        let restored = store.filteredPlans(now: now)
        #expect(restored.count == 2)
    }

    @Test("Switching selected project loads project-specific plans and clears previous data")
    func selectProjectSwitchesData() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (1, 'repo-1', 'Project One')")
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (2, 'repo-2', 'Project Two')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('plan-p1', 1, 1, 'pending')")
            execSQL(
                db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('plan-p2', 2, 2, 'in_progress')")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (1, 1, '/tmp/workspace-1', 'WS for P1', 0)")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (2, 2, '/tmp/workspace-2', 'WS for P2', 0)")
        }

        let store = ProjectTrackingStore(dbPath: path)

        // Select project 1 and refresh
        store.selectedProjectId = "1"
        await store.refresh()
        #expect(store.plans.count == 1)
        #expect(store.plans.first?.uuid == "plan-p1")
        #expect(store.workspaces.count == 1)
        #expect(store.workspaces.first?.id == "1")

        // Switch to project 2
        store.selectedProjectId = "2"
        await store.refresh()
        #expect(store.plans.count == 1)
        #expect(store.plans.first?.uuid == "plan-p2")
        #expect(store.workspaces.count == 1)
        #expect(store.workspaces.first?.id == "2")

        // Deselect project → workspaces and plans cleared
        store.selectedProjectId = nil
        await store.refresh()
        #expect(store.plans.isEmpty)
        #expect(store.workspaces.isEmpty)
        // Projects list is still populated regardless
        #expect(store.projects.count == 2)
    }

    @Test("Expanding to all statuses reveals plans hidden by default filters")
    func expandToAllStatusesRevealsHiddenPlans() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        let oldISO = isoDateString(Date().addingTimeInterval(-10 * 24 * 60 * 60))

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('pending-1', 1, 1, 'pending')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status, updated_at) VALUES ('old-done', 1, 2, 'done', '\(oldISO)')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('cancelled-1', 1, 3, 'cancelled')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('deferred-1', 1, 4, 'deferred')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let now = Date()

        // Default filters: only pending visible; old-done, cancelled, deferred are hidden
        let defaultFiltered = store.filteredPlans(now: now)
        let defaultUuids = Set(defaultFiltered.map(\.uuid))
        #expect(defaultUuids.contains("pending-1"))
        #expect(!defaultUuids.contains("old-done"))
        #expect(!defaultUuids.contains("cancelled-1"))
        #expect(!defaultUuids.contains("deferred-1"))

        // Expand to all statuses → all 4 plans visible
        store.activeFilters = Set(PlanDisplayStatus.allCases)
        let allVisible = store.filteredPlans(now: now)
        #expect(allVisible.count == 4)
        let allUuids = Set(allVisible.map(\.uuid))
        #expect(allUuids.contains("old-done"))
        #expect(allUuids.contains("cancelled-1"))
        #expect(allUuids.contains("deferred-1"))
    }

    // MARK: - Plans Browser Filter Scenarios

    @Test("Resetting filters from All-selected state restores default filter set")
    func resetFiltersFromAllSelectedRestoresDefaults() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        let oldISO = isoDateString(Date().addingTimeInterval(-10 * 24 * 60 * 60))

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('pending-1', 1, 1, 'pending')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status, updated_at) VALUES ('old-done', 1, 2, 'done', '\(oldISO)')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('cancelled-1', 1, 3, 'cancelled')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let now = Date()

        // Expand to all statuses (simulates pressing "All" button in FilterChipsView)
        store.activeFilters = Set(PlanDisplayStatus.allCases)
        let allVisible = store.filteredPlans(now: now)
        #expect(allVisible.count == 3)

        // Reset to defaults (simulates pressing "Reset" button in FilterChipsView)
        store.activeFilters = defaultPlanFilters()
        let afterReset = store.filteredPlans(now: now)
        let afterResetUuids = Set(afterReset.map(\.uuid))

        // Only pending should be visible after reset
        #expect(afterResetUuids.contains("pending-1"))
        #expect(!afterResetUuids.contains("old-done"))
        #expect(!afterResetUuids.contains("cancelled-1"))

        // The active filters should match the canonical default set
        #expect(store.activeFilters == defaultPlanFilters())
    }

    @Test("Single status filter shows only plans matching that exact status")
    func singleStatusFilterShowsOnlyMatchingPlans() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('p1', 1, 1, 'pending')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('p2', 1, 2, 'in_progress')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('p3', 1, 3, 'cancelled')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        store.activeFilters = [.inProgress]
        await store.refresh()

        let filtered = store.filteredPlans(now: Date())
        #expect(filtered.count == 1)
        #expect(filtered.first?.uuid == "p2")
    }

    @Test("filteredPlans respects filter changes without re-fetching from DB")
    func filteredPlansRespectsLiveFilterChanges() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('pending-1', 1, 1, 'pending')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('inprogress-1', 1, 2, 'in_progress')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('deferred-1', 1, 3, 'deferred')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let now = Date()

        // Start with default: pending and inprogress shown, deferred hidden
        let defaultResult = store.filteredPlans(now: now)
        let defaultUuids = Set(defaultResult.map(\.uuid))
        #expect(defaultUuids.contains("pending-1"))
        #expect(defaultUuids.contains("inprogress-1"))
        #expect(!defaultUuids.contains("deferred-1"))

        // Add deferred to filters without re-fetching
        store.activeFilters.insert(.deferred)
        let withDeferred = store.filteredPlans(now: now)
        let withDeferredUuids = Set(withDeferred.map(\.uuid))
        #expect(withDeferredUuids.contains("pending-1"))
        #expect(withDeferredUuids.contains("inprogress-1"))
        #expect(withDeferredUuids.contains("deferred-1"))

        // Remove pending from filters
        store.activeFilters.remove(.pending)
        let withoutPending = store.filteredPlans(now: now)
        let withoutPendingUuids = Set(withoutPending.map(\.uuid))
        #expect(!withoutPendingUuids.contains("pending-1"))
        #expect(withoutPendingUuids.contains("inprogress-1"))
        #expect(withoutPendingUuids.contains("deferred-1"))
    }

    // MARK: - DB Path Resolution

    @Test("resolveDefaultDBPath returns non-nil path ending in tim.db by default")
    func resolveDefaultDBPathDefaultSuffix() {
        let path = ProjectTrackingStore.resolveDefaultDBPath()
        #expect(path != nil)
        #expect(path?.hasSuffix("tim.db") == true)
    }

    @Test("resolveDefaultDBPath returns a path with /tim/ directory component")
    func resolveDefaultDBPathContainsTim() {
        let path = ProjectTrackingStore.resolveDefaultDBPath()
        #expect(path?.contains("/tim/") == true)
    }

    @Test("resolveDefaultDBPath uses TIM_DATABASE_FILENAME when set in environment")
    func resolveDefaultDBPathCustomFilename() {
        let customFilename = "mytest.db"
        let prev = getenv("TIM_DATABASE_FILENAME").map { String(cString: $0) }
        setenv("TIM_DATABASE_FILENAME", customFilename, 1)
        defer {
            if let prev { setenv("TIM_DATABASE_FILENAME", prev, 1) } else { unsetenv("TIM_DATABASE_FILENAME") }
        }
        let path = ProjectTrackingStore.resolveDefaultDBPath()
        #expect(path?.hasSuffix(customFilename) == true)
    }

    @Test("resolveDefaultDBPath ignores empty XDG_CONFIG_HOME and falls back to home directory")
    func resolveDefaultDBPathFallsBackForEmptyXdg() {
        let prev = getenv("XDG_CONFIG_HOME").map { String(cString: $0) }
        setenv("XDG_CONFIG_HOME", "", 1)
        defer {
            if let prev { setenv("XDG_CONFIG_HOME", prev, 1) } else { unsetenv("XDG_CONFIG_HOME") }
        }
        let path = ProjectTrackingStore.resolveDefaultDBPath()
        let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
        #expect(path?.hasPrefix(homeDir) == true)
        #expect(path?.contains("/.config/tim/") == true)
    }

    @Test("resolveDefaultDBPath ignores whitespace-only XDG_CONFIG_HOME and falls back to home directory")
    func resolveDefaultDBPathFallsBackForWhitespaceXdg() {
        let prev = getenv("XDG_CONFIG_HOME").map { String(cString: $0) }
        setenv("XDG_CONFIG_HOME", "   ", 1)
        defer {
            if let prev { setenv("XDG_CONFIG_HOME", prev, 1) } else { unsetenv("XDG_CONFIG_HOME") }
        }
        let path = ProjectTrackingStore.resolveDefaultDBPath()
        let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
        #expect(path?.hasPrefix(homeDir) == true)
        #expect(path?.contains("/.config/tim/") == true)
    }

    @Test("resolveDefaultDBPath uses non-empty XDG_CONFIG_HOME when set")
    func resolveDefaultDBPathUsesValidXdg() {
        let customXdg = "/tmp/test-xdg-\(UUID().uuidString)"
        let prev = getenv("XDG_CONFIG_HOME").map { String(cString: $0) }
        setenv("XDG_CONFIG_HOME", customXdg, 1)
        defer {
            if let prev { setenv("XDG_CONFIG_HOME", prev, 1) } else { unsetenv("XDG_CONFIG_HOME") }
        }
        let path = ProjectTrackingStore.resolveDefaultDBPath()
        #expect(path?.hasPrefix(customXdg) == true)
        #expect(path?.hasSuffix("/tim/tim.db") == true)
    }

    // MARK: - Refresh Lifecycle

    @Test("startRefreshing performs initial load and transitions to loaded state")
    func startRefreshingPerformsInitialLoad() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (1, 'repo-1', 'My Project')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        #expect(store.loadState == .idle)

        store.startRefreshing()
        // Give the initial refresh time to complete
        try await Task.sleep(for: .milliseconds(500))

        #expect(store.loadState == .loaded)
        #expect(store.projects.count == 1)
        #expect(store.projects.first?.displayName == "My Project")

        store.stopRefreshing()
    }

    @Test("stopRefreshing cancels the refresh loop without error")
    func stopRefreshingCancelsLoop() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.startRefreshing()
        try await Task.sleep(for: .milliseconds(200))

        // stopRefreshing should not crash and should cancel the task
        store.stopRefreshing()
        // Calling stopRefreshing again should be safe (idempotent)
        store.stopRefreshing()

        // State should be stable after stopping
        #expect(store.loadState == .loaded)
    }

    @Test(
        "Reference-counted refresh: startRefreshing twice + stopRefreshing once keeps refreshing, second stop fully stops")
    func referenceCountedRefreshLifecycle() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
        }

        let store = ProjectTrackingStore(dbPath: path)

        // Start two consumers (reference count = 2)
        store.startRefreshing()
        store.startRefreshing()

        // Wait for initial load to complete using polling
        for _ in 0..<100 {
            if store.loadState == .loaded { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(store.loadState == .loaded)

        // Stop one consumer — store should still be refreshing (count=1)
        store.stopRefreshing()
        // Give a moment for any erroneous cancellation to take effect
        try await Task.sleep(for: .milliseconds(100))
        #expect(store.loadState == .loaded, "Store should remain loaded with one active consumer")

        // Stop second consumer — now truly stopped (count=0)
        store.stopRefreshing()
    }

    @Test("startRefreshing can restart after stopRefreshing and picks up DB changes")
    func startRefreshingRestartAfterStop() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.startRefreshing()
        try await Task.sleep(for: .milliseconds(200))
        store.stopRefreshing()

        // Add another project while the refresh loop is stopped
        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (2, 'repo-2')")
        }

        // Restarting should perform a new initial load and pick up the added project
        store.startRefreshing()
        try await Task.sleep(for: .milliseconds(500))
        store.stopRefreshing()

        #expect(store.loadState == .loaded)
        #expect(store.projects.count == 2)
    }

    // MARK: - Refresh Coalescing

    @Test("selectProject after initial load switches to new project data")
    func selectProjectAfterInitialLoadSwitchesData() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (1, 'repo-1', 'Project One')")
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (2, 'repo-2', 'Project Two')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('plan-p1', 1, 1, 'pending')")
            execSQL(
                db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('plan-p2', 2, 2, 'in_progress')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()
        #expect(store.plans.count == 1)
        #expect(store.plans.first?.uuid == "plan-p1")

        // Switch to project 2 via selectProject (enqueues a refresh Task internally)
        store.selectProject(id: "2")
        try await Task.sleep(for: .milliseconds(500))

        // After settling, should show project 2's data
        #expect(store.selectedProjectId == "2")
        #expect(store.plans.count == 1)
        #expect(store.plans.first?.uuid == "plan-p2")
    }

    @Test("Concurrent refresh with project change results in correct final state")
    func concurrentRefreshWithProjectChangeResultsInCorrectState() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (1, 'repo-1', 'Project One')")
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (2, 'repo-2', 'Project Two')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('plan-p1', 1, 1, 'pending')")
            execSQL(
                db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('plan-p2', 2, 2, 'in_progress')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"

        // Start a refresh and concurrently change project selection.
        // The needsRefresh flag ensures the refresh loop will re-run for the new selection.
        async let firstRefresh: Void = store.refresh()
        // selectProject changes selectedProjectId to "2" and enqueues another refresh.
        // If the first refresh is already in-flight, it sets needsRefresh = true.
        store.selectProject(id: "2")
        await firstRefresh

        // Wait for any enqueued follow-up refresh tasks (from selectProject) to complete
        try await Task.sleep(for: .milliseconds(500))

        // Regardless of the internal coalescing timing, the final state must reflect
        // the most-recently-selected project (2), not any stale project (1) data.
        #expect(store.selectedProjectId == "2")
        #expect(store.plans.count == 1)
        #expect(store.plans.first?.uuid == "plan-p2")
    }

    @Test("Stale project data is not committed when selectedProjectId changes mid-refresh")
    func staleProjectDataNotCommittedAfterSelectionChange() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (1, 'repo-1', 'Project One')")
            execSQL(db, "INSERT INTO project (id, repository_id, remote_label) VALUES (2, 'repo-2', 'Project Two')")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (1, 1, '/tmp/workspace-1', 'WS-P1', 0)")
            execSQL(
                db,
                "INSERT INTO workspace (id, project_id, workspace_path, name, is_primary) VALUES (2, 2, '/tmp/workspace-2', 'WS-P2', 0)")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('plan-p1', 1, 1, 'pending')")
            execSQL(
                db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('plan-p2', 2, 2, 'in_progress')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        // Select project 1 first
        store.selectedProjectId = "1"
        await store.refresh()
        #expect(store.workspaces.first?.id == "1")

        // Quickly switch to project 2 (simulates user clicking a different project)
        store.selectedProjectId = "2"
        await store.refresh()

        // Must show project 2's workspaces and plans, not project 1's stale data
        #expect(store.workspaces.count == 1)
        #expect(store.workspaces.first?.id == "2")
        #expect(store.plans.count == 1)
        #expect(store.plans.first?.uuid == "plan-p2")
    }

    // MARK: - Active Work Dashboard Logic

    // Tests for the hasActivePlans / hasRecentlyActiveWorkspaces logic used by ProjectDetailView
    // to decide whether to show the active work dashboard or an empty state.

    @Test("Active work: project with in-progress plan has active plans")
    func activeWorkHasActivePlanInProgress() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('active-plan', 1, 1, 'in_progress')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let now = Date()
        let hasActivePlans = store.plans.contains { plan in
            store.displayStatus(for: plan, now: now).isActiveWork
        }
        #expect(hasActivePlans)
    }

    @Test("Active work: pending plan with unresolved deps counts as active (blocked)")
    func activeWorkBlockedPlanCountsAsActive() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('blocker', 1, 1, 'pending')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('blocked-plan', 1, 2, 'pending')")
            execSQL(db, "INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES ('blocked-plan', 'blocker')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let now = Date()
        let hasActivePlans = store.plans.contains { plan in
            store.displayStatus(for: plan, now: now).isActiveWork
        }
        #expect(hasActivePlans)
        // Verify the blocked plan's status specifically
        let blockedPlan = try #require(store.plans.first { $0.uuid == "blocked-plan" })
        #expect(store.displayStatus(for: blockedPlan, now: now) == .blocked)
    }

    @Test("Active work: project with only pending/done/cancelled plans has no active plans")
    func activeWorkNoActivePlansWhenOnlyInactivePlans() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        let oldISO = isoDateString(Date().addingTimeInterval(-10 * 24 * 60 * 60))

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('pending-plan', 1, 1, 'pending')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status, updated_at) VALUES ('old-done', 1, 2, 'done', '\(oldISO)')")
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('cancelled-plan', 1, 3, 'cancelled')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let now = Date()
        let hasActivePlans = store.plans.contains { plan in
            store.displayStatus(for: plan, now: now).isActiveWork
        }
        #expect(!hasActivePlans)
    }

    @Test("Active work: empty state when no recently active workspaces and no active plans")
    func activeWorkEmptyStateWhenNoRecentlyActiveWorkspacesAndNoActivePlans() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            // Only a pending plan (not in-progress, not blocked)
            execSQL(db, "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('pending-plan', 1, 1, 'pending')")
            // No workspaces
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let now = Date()
        let hasRecentlyActiveWorkspaces = store.workspaces.contains { workspace in
            workspace.isRecentlyActive(now: now)
        }
        let hasActivePlans = store.plans.contains { plan in
            store.displayStatus(for: plan, now: now).isActiveWork
        }

        // Both conditions false → empty state should be shown
        #expect(!hasRecentlyActiveWorkspaces)
        #expect(!hasActivePlans)
    }

    @Test("Active work: stale workspace alone does not prevent empty state")
    func activeWorkStaleWorkspaceDoesNotPreventEmptyState() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        let staleISO = isoDateString(Date().addingTimeInterval(-72 * 60 * 60))
        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                """
                INSERT INTO workspace (id, project_id, workspace_path, is_primary, updated_at)
                VALUES (1, 1, '/tmp/ws-1', 0, '\(staleISO)')
                """)
            // No plans at all
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let now = Date()
        let hasRecentlyActiveWorkspaces = store.workspaces.contains { workspace in
            workspace.isRecentlyActive(now: now)
        }
        let hasActivePlans = store.plans.contains { plan in
            store.displayStatus(for: plan, now: now).isActiveWork
        }

        #expect(!hasRecentlyActiveWorkspaces)
        #expect(!hasActivePlans)
    }

    @Test("Active work: recently active workspace keeps dashboard non-empty without active plans")
    func activeWorkRecentlyActiveWorkspaceKeepsDashboardVisible() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        let recentISO = isoDateString(Date().addingTimeInterval(-2 * 60 * 60))
        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                """
                INSERT INTO workspace (id, project_id, workspace_path, is_primary, updated_at)
                VALUES (1, 1, '/tmp/ws-1', 0, '\(recentISO)')
                """)
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let now = Date()
        let hasRecentlyActiveWorkspaces = store.workspaces.contains { workspace in
            workspace.isRecentlyActive(now: now)
        }
        let hasActivePlans = store.plans.contains { plan in
            store.displayStatus(for: plan, now: now).isActiveWork
        }

        #expect(hasRecentlyActiveWorkspaces)
        #expect(!hasActivePlans)
    }

    @Test("Active work: workspace with assigned plan title shows linked plan info")
    func activeWorkWorkspaceLinkedToPlan() async throws {
        let (path, cleanup) = try makeTestDBPath()
        defer { cleanup() }

        withTestDB(path: path) { db in
            execSQL(db, "INSERT INTO project (id, repository_id) VALUES (1, 'repo-1')")
            execSQL(
                db,
                """
                INSERT INTO workspace (id, project_id, workspace_path, name, plan_id, plan_title, is_primary)
                VALUES (1, 1, '/tmp/ws-1', 'My Workspace', 42, 'Active Feature Plan', 0)
                """)
            execSQL(
                db,
                "INSERT INTO plan (uuid, project_id, plan_id, status) VALUES ('linked-plan', 1, 42, 'in_progress')")
        }

        let store = ProjectTrackingStore(dbPath: path)
        store.selectedProjectId = "1"
        await store.refresh()

        let workspace = try #require(store.workspaces.first)
        #expect(workspace.planId == 42)
        #expect(workspace.planTitle == "Active Feature Plan")
        #expect(workspace.displayName == "My Workspace")
    }
}
