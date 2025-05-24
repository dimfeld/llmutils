import { logSpawn } from '../../rmfilter/utils';
import type { ChangeAnalysis } from './types';

export class ChangeAnalyzer {
  async analyzeChanges(branchName: string, baseRef: string, cwd: string): Promise<ChangeAnalysis> {
    const stats = await this.getGitStats(branchName, baseRef, cwd);
    const testFiles = await this.findTestFiles(branchName, baseRef, cwd);
    const affectedAreas = await this.identifyAffectedAreas(branchName, baseRef, cwd);
    const breaking = await this.detectBreakingChanges(branchName, baseRef, cwd);

    return {
      ...stats,
      testsCoverage: {
        hasTests: testFiles.length > 0,
        testFiles,
      },
      breaking,
      riskLevel: this.assessRiskLevel(stats, testFiles, breaking),
      affectedAreas,
    };
  }

  private async getGitStats(
    branchName: string,
    baseRef: string,
    cwd: string
  ): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
    try {
      const proc = logSpawn(['git', 'diff', '--numstat', `${baseRef}...${branchName}`], {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd,
      });
      
      const output = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
      const exitCode = await proc.exited;
      
      const result = {
        success: exitCode === 0,
        output,
      };

      if (!result.success || !result.output) {
        return { filesChanged: 0, insertions: 0, deletions: 0 };
      }

      const lines = result.output.trim().split('\n').filter(Boolean);
      let insertions = 0;
      let deletions = 0;

      for (const line of lines) {
        const [added, removed] = line.split('\t');
        if (added !== '-') insertions += parseInt(added, 10) || 0;
        if (removed !== '-') deletions += parseInt(removed, 10) || 0;
      }

      return {
        filesChanged: lines.length,
        insertions,
        deletions,
      };
    } catch (error) {
      console.error('Failed to get git stats:', error);
      return { filesChanged: 0, insertions: 0, deletions: 0 };
    }
  }

  private async findTestFiles(branchName: string, baseRef: string, cwd: string): Promise<string[]> {
    try {
      const proc = logSpawn(['git', 'diff', '--name-only', `${baseRef}...${branchName}`], {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd,
      });
      
      const output = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
      const exitCode = await proc.exited;
      
      const result = {
        success: exitCode === 0,
        output,
      };

      if (!result.success || !result.output) {
        return [];
      }

      const files = result.output.trim().split('\n').filter(Boolean);
      return files.filter(
        (file: string) =>
          file.includes('.test.') ||
          file.includes('.spec.') ||
          file.includes('__tests__/') ||
          file.includes('tests/')
      );
    } catch (error) {
      console.error('Failed to find test files:', error);
      return [];
    }
  }

  private async identifyAffectedAreas(
    branchName: string,
    baseRef: string,
    cwd: string
  ): Promise<string[]> {
    try {
      const proc = logSpawn(['git', 'diff', '--name-only', `${baseRef}...${branchName}`], {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd,
      });
      
      const output = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
      const exitCode = await proc.exited;
      
      const result = {
        success: exitCode === 0,
        output,
      };

      if (!result.success || !result.output) {
        return [];
      }

      const files = result.output.trim().split('\n').filter(Boolean);
      const areas = new Set<string>();

      for (const file of files) {
        // Extract top-level directory
        const parts = file.split('/');
        if (parts.length > 1 && parts[0] === 'src' && parts.length > 2) {
          areas.add(parts[1]);
        } else if (parts[0] !== 'src') {
          areas.add(parts[0]);
        }
      }

      return Array.from(areas).sort();
    } catch (error) {
      console.error('Failed to identify affected areas:', error);
      return [];
    }
  }

  private async detectBreakingChanges(
    branchName: string,
    baseRef: string,
    cwd: string
  ): Promise<boolean> {
    try {
      const proc = logSpawn(['git', 'diff', `${baseRef}...${branchName}`, '--', '*.ts', '*.js'], {
        stdout: 'pipe',
        stderr: 'pipe',
        cwd,
      });
      
      const output = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
      const exitCode = await proc.exited;
      
      const result = {
        success: exitCode === 0,
        output,
      };

      if (!result.success || !result.output) {
        return false;
      }

      const diff = result.output;

      // Simple heuristics for breaking changes
      const breakingPatterns = [
        /^-\s*export\s+(class|interface|type|function|const|let|var)\s+/gm, // Removed exports
        /^-\s*public\s+/gm, // Removed public methods
        /BREAKING/gi, // Explicit breaking change markers
        /\bremoved\b/gi, // Removal mentions
        /\bdeprecated\b.*\bremoved\b/gi, // Deprecated then removed
      ];

      for (const pattern of breakingPatterns) {
        if (pattern.test(diff)) {
          return true;
        }
      }

      return false;
    } catch (error) {
      console.error('Failed to detect breaking changes:', error);
      return false;
    }
  }

  private assessRiskLevel(
    stats: { filesChanged: number; insertions: number; deletions: number },
    testFiles: string[],
    breaking: boolean
  ): 'low' | 'medium' | 'high' {
    if (breaking) return 'high';
    if (stats.filesChanged > 20 || stats.insertions + stats.deletions > 500) return 'high';
    if (stats.filesChanged > 10 || stats.insertions + stats.deletions > 200) return 'medium';
    if (testFiles.length === 0 && stats.filesChanged > 5) return 'medium';
    return 'low';
  }
}