import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Migration {
  version: number;
  name: string;
  up: string;
  down?: string;
}

export class MigrationManager {
  constructor(private db: Database) {}

  async initialize(): Promise<void> {
    // Create migrations table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async getCurrentVersion(): Promise<number> {
    const result = this.db
      .query<{ version: number }, []>('SELECT MAX(version) as version FROM migrations')
      .get();
    return result?.version ?? 0;
  }

  async migrate(): Promise<void> {
    await this.initialize();
    const currentVersion = await this.getCurrentVersion();
    const migrations = await this.loadMigrations();

    for (const migration of migrations) {
      if (migration.version > currentVersion) {
        await this.applyMigration(migration);
      }
    }
  }

  private async applyMigration(migration: Migration): Promise<void> {
    const transaction = this.db.transaction(() => {
      // Execute the migration
      this.db.exec(migration.up);

      // Record the migration
      this.db
        .prepare('INSERT INTO migrations (version, name) VALUES (?, ?)')
        .run(migration.version, migration.name);
    });

    try {
      transaction();
      console.log(`Applied migration ${migration.version}: ${migration.name}`);
    } catch (error) {
      console.error(`Failed to apply migration ${migration.version}: ${migration.name}`, error);
      throw error;
    }
  }

  private async loadMigrations(): Promise<Migration[]> {
    const migrations: Migration[] = [
      {
        version: 1,
        name: 'initial_schema',
        up: readFileSync(join(__dirname, 'schema.sql'), 'utf-8'),
      },
    ];

    return migrations.sort((a, b) => a.version - b.version);
  }

  async rollback(targetVersion: number = 0): Promise<void> {
    const currentVersion = await this.getCurrentVersion();
    if (targetVersion >= currentVersion) {
      throw new Error('Target version must be less than current version');
    }

    const migrations = await this.loadMigrations();
    const migrationsToRollback = migrations
      .filter((m) => m.version > targetVersion && m.version <= currentVersion)
      .reverse();

    for (const migration of migrationsToRollback) {
      if (!migration.down) {
        throw new Error(`Migration ${migration.version} does not support rollback`);
      }

      const transaction = this.db.transaction(() => {
        this.db.exec(migration.down!);
        this.db.prepare('DELETE FROM migrations WHERE version = ?').run(migration.version);
      });

      try {
        transaction();
        console.log(`Rolled back migration ${migration.version}: ${migration.name}`);
      } catch (error) {
        console.error(
          `Failed to rollback migration ${migration.version}: ${migration.name}`,
          error
        );
        throw error;
      }
    }
  }
}
