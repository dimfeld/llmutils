import type { 
  IssueAnalysis, 
  EnrichedAnalysis, 
  CodebaseContext,
  RelatedChange,
  Convention,
  RepoContext 
} from './types.js';
import { spawnAndLogOutput } from '../../rmfilter/utils.js';
import { log } from '../../logging.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export class ContextEnricher {
  async enrich(
    analysis: IssueAnalysis,
    context: RepoContext
  ): Promise<EnrichedAnalysis> {
    const codebaseContext = await this.gatherCodebaseContext(context);
    const relatedChanges = await this.findRelatedChanges(analysis, context);
    const conventions = await this.detectConventions(context);
    
    return {
      ...analysis,
      codebaseContext,
      relatedChanges,
      conventions,
    };
  }

  private async gatherCodebaseContext(context: RepoContext): Promise<CodebaseContext> {
    const languages = await this.detectLanguages(context);
    const frameworks = await this.detectFrameworks(context);
    const architectureStyle = await this.detectArchitectureStyle(context);
    const testingApproach = await this.detectTestingApproach(context);
    
    return {
      primaryLanguages: languages,
      frameworks,
      architectureStyle,
      testingApproach,
    };
  }

  private async detectLanguages(context: RepoContext): Promise<string[]> {
    const languages = new Map<string, number>();
    
    try {
      // Count files by extension
      const result = await spawnAndLogOutput(
        ['find', '.', '-type', 'f', '-name', '*.*', '!', '-path', '*/node_modules/*', '!', '-path', '*/.git/*'],
        { cwd: context.workDir }
      );
      
      if (result.exitCode === 0) {
        const files = result.stdout.split('\n').filter(Boolean);
        
        for (const file of files) {
          const ext = path.extname(file).toLowerCase();
          const lang = this.extensionToLanguage(ext);
          if (lang) {
            languages.set(lang, (languages.get(lang) || 0) + 1);
          }
        }
      }
    } catch (error) {
      log('Error detecting languages:', error);
    }
    
    // Sort by count and return top languages
    return Array.from(languages.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([lang]) => lang);
  }

  private extensionToLanguage(ext: string): string | null {
    const mapping: Record<string, string> = {
      '.ts': 'TypeScript',
      '.tsx': 'TypeScript',
      '.js': 'JavaScript',
      '.jsx': 'JavaScript',
      '.py': 'Python',
      '.java': 'Java',
      '.go': 'Go',
      '.rs': 'Rust',
      '.cpp': 'C++',
      '.c': 'C',
      '.cs': 'C#',
      '.rb': 'Ruby',
      '.php': 'PHP',
      '.swift': 'Swift',
      '.kt': 'Kotlin',
      '.scala': 'Scala',
      '.r': 'R',
      '.m': 'Objective-C',
      '.mm': 'Objective-C++',
    };
    
    return mapping[ext] || null;
  }

  private async detectFrameworks(context: RepoContext): Promise<string[]> {
    const frameworks: string[] = [];
    
    try {
      // Check package.json for Node.js frameworks
      const packageJsonPath = path.join(context.workDir, 'package.json');
      try {
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
        const deps = {
          ...packageJson.dependencies,
          ...packageJson.devDependencies,
        };
        
        // Check for common frameworks
        if (deps.react || deps['react-dom']) frameworks.push('React');
        if (deps.vue) frameworks.push('Vue');
        if (deps.angular || deps['@angular/core']) frameworks.push('Angular');
        if (deps.svelte) frameworks.push('Svelte');
        if (deps.next) frameworks.push('Next.js');
        if (deps.nuxt) frameworks.push('Nuxt');
        if (deps.express) frameworks.push('Express');
        if (deps.fastify) frameworks.push('Fastify');
        if (deps.koa) frameworks.push('Koa');
        if (deps.nestjs || deps['@nestjs/core']) frameworks.push('NestJS');
        if (deps.jest) frameworks.push('Jest');
        if (deps.mocha) frameworks.push('Mocha');
        if (deps.vitest) frameworks.push('Vitest');
      } catch (e) {
        // Not a Node.js project or no package.json
      }
      
      // Check for other language frameworks
      const checkFiles = [
        { file: 'pom.xml', framework: 'Maven' },
        { file: 'build.gradle', framework: 'Gradle' },
        { file: 'Cargo.toml', framework: 'Rust/Cargo' },
        { file: 'go.mod', framework: 'Go Modules' },
        { file: 'requirements.txt', framework: 'Python' },
        { file: 'Pipfile', framework: 'Pipenv' },
        { file: 'pyproject.toml', framework: 'Python/Poetry' },
        { file: 'Gemfile', framework: 'Ruby/Bundler' },
        { file: 'composer.json', framework: 'PHP/Composer' },
      ];
      
      for (const { file, framework } of checkFiles) {
        try {
          await fs.access(path.join(context.workDir, file));
          frameworks.push(framework);
        } catch (e) {
          // File doesn't exist
        }
      }
    } catch (error) {
      log('Error detecting frameworks:', error);
    }
    
    return frameworks;
  }

  private async detectArchitectureStyle(context: RepoContext): Promise<string> {
    try {
      // Look for common architecture patterns in directory structure
      const dirs = await this.getTopLevelDirs(context);
      
      if (dirs.includes('src') && dirs.includes('test')) {
        if (dirs.includes('controllers') || dirs.includes('routes')) {
          return 'MVC';
        }
        if (dirs.includes('domain') || dirs.includes('application')) {
          return 'Domain-Driven Design';
        }
        if (dirs.includes('features')) {
          return 'Feature-based';
        }
        if (dirs.includes('components')) {
          return 'Component-based';
        }
      }
      
      // Check for microservices
      if (dirs.includes('services') || dirs.includes('packages')) {
        const servicesCount = await this.countSubdirectories(
          path.join(context.workDir, dirs.includes('services') ? 'services' : 'packages')
        );
        if (servicesCount > 3) {
          return 'Microservices';
        }
        return 'Monorepo';
      }
    } catch (error) {
      log('Error detecting architecture:', error);
    }
    
    return 'Traditional';
  }

  private async detectTestingApproach(context: RepoContext): Promise<string> {
    const approaches: string[] = [];
    
    try {
      // Check for test directories and files
      const result = await spawnAndLogOutput(
        ['find', '.', '-type', 'f', '(', '-name', '*.test.*', '-o', '-name', '*.spec.*', '-o', '-name', '*_test.*', ')', '!', '-path', '*/node_modules/*'],
        { cwd: context.workDir }
      );
      
      if (result.exitCode === 0) {
        const testFiles = result.stdout.split('\n').filter(Boolean);
        
        if (testFiles.length > 0) {
          // Analyze test file patterns
          const hasUnit = testFiles.some(f => f.includes('unit') || f.includes('.test.'));
          const hasIntegration = testFiles.some(f => f.includes('integration') || f.includes('e2e'));
          const hasSpec = testFiles.some(f => f.includes('.spec.'));
          
          if (hasUnit) approaches.push('Unit Testing');
          if (hasIntegration) approaches.push('Integration Testing');
          if (hasSpec) approaches.push('BDD/Spec Testing');
          
          // Check for specific test frameworks
          const fileContent = await fs.readFile(testFiles[0], 'utf-8').catch(() => '');
          if (fileContent.includes('describe(') && fileContent.includes('it(')) {
            approaches.push('BDD-style');
          } else if (fileContent.includes('test(') || fileContent.includes('Test')) {
            approaches.push('TDD-style');
          }
        }
      }
    } catch (error) {
      log('Error detecting testing approach:', error);
    }
    
    return approaches.join(', ') || 'No tests found';
  }

  private async findRelatedChanges(
    analysis: IssueAnalysis,
    context: RepoContext
  ): Promise<RelatedChange[]> {
    const changes: RelatedChange[] = [];
    
    try {
      // Search for commits related to the affected files
      for (const file of analysis.technicalScope.affectedFiles.slice(0, 5)) {
        const result = await spawnAndLogOutput(
          ['git', 'log', '--oneline', '-n', '5', '--', file],
          { cwd: context.workDir }
        );
        
        if (result.exitCode === 0 && result.stdout) {
          const commits = result.stdout.split('\n').filter(Boolean);
          
          for (const commit of commits) {
            const [hash, ...messageParts] = commit.split(' ');
            const message = messageParts.join(' ');
            
            changes.push({
              commit: hash,
              description: message,
              files: [file],
              relevance: 0.8,
            });
          }
        }
      }
      
      // Remove duplicates and sort by relevance
      const uniqueChanges = new Map<string, RelatedChange>();
      for (const change of changes) {
        const existing = uniqueChanges.get(change.commit);
        if (!existing || existing.relevance < change.relevance) {
          uniqueChanges.set(change.commit, change);
        }
      }
      
      return Array.from(uniqueChanges.values())
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, 10);
    } catch (error) {
      log('Error finding related changes:', error);
    }
    
    return changes;
  }

  private async detectConventions(context: RepoContext): Promise<Convention[]> {
    const conventions: Convention[] = [];
    
    try {
      // Check for linting/formatting configs
      const configFiles = [
        { file: '.eslintrc', type: 'style', desc: 'ESLint configuration' },
        { file: '.prettierrc', type: 'style', desc: 'Prettier formatting' },
        { file: 'tslint.json', type: 'style', desc: 'TSLint configuration' },
        { file: '.editorconfig', type: 'style', desc: 'EditorConfig settings' },
        { file: 'rustfmt.toml', type: 'style', desc: 'Rust formatting' },
        { file: '.rubocop.yml', type: 'style', desc: 'RuboCop Ruby style' },
      ];
      
      for (const { file, type, desc } of configFiles) {
        try {
          await fs.access(path.join(context.workDir, file));
          conventions.push({
            type: type as Convention['type'],
            description: desc,
            examples: [],
          });
        } catch (e) {
          // File doesn't exist
        }
      }
      
      // Analyze naming patterns
      const namingConvention = await this.detectNamingConvention(context);
      if (namingConvention) {
        conventions.push(namingConvention);
      }
      
      // Analyze file structure patterns
      const structureConvention = await this.detectStructureConvention(context);
      if (structureConvention) {
        conventions.push(structureConvention);
      }
    } catch (error) {
      log('Error detecting conventions:', error);
    }
    
    return conventions;
  }

  private async detectNamingConvention(context: RepoContext): Promise<Convention | null> {
    try {
      const result = await spawnAndLogOutput(
        ['find', '.', '-type', 'f', '-name', '*.ts', '-o', '-name', '*.js', '!', '-path', '*/node_modules/*'],
        { cwd: context.workDir }
      );
      
      if (result.exitCode === 0) {
        const files = result.stdout.split('\n').filter(Boolean).slice(0, 20);
        const patterns = {
          camelCase: 0,
          kebabCase: 0,
          snakeCase: 0,
          pascalCase: 0,
        };
        
        for (const file of files) {
          const basename = path.basename(file, path.extname(file));
          if (basename.includes('-')) patterns.kebabCase++;
          else if (basename.includes('_')) patterns.snakeCase++;
          else if (basename[0] === basename[0].toUpperCase()) patterns.pascalCase++;
          else patterns.camelCase++;
        }
        
        const dominant = Object.entries(patterns)
          .sort((a, b) => b[1] - a[1])[0];
        
        if (dominant[1] > files.length * 0.5) {
          return {
            type: 'naming',
            description: `File naming convention: ${dominant[0]}`,
            examples: files.slice(0, 3),
          };
        }
      }
    } catch (error) {
      log('Error detecting naming convention:', error);
    }
    
    return null;
  }

  private async detectStructureConvention(context: RepoContext): Promise<Convention | null> {
    try {
      const dirs = await this.getTopLevelDirs(context);
      
      if (dirs.includes('src')) {
        const srcDirs = await this.getSubdirectories(path.join(context.workDir, 'src'));
        
        return {
          type: 'structure',
          description: 'Source code organization',
          examples: srcDirs.map(d => `src/${d}`).slice(0, 5),
        };
      }
    } catch (error) {
      log('Error detecting structure convention:', error);
    }
    
    return null;
  }

  private async getTopLevelDirs(context: RepoContext): Promise<string[]> {
    try {
      const entries = await fs.readdir(context.workDir, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name);
    } catch (error) {
      log('Error reading top-level directories:', error);
      return [];
    }
  }

  private async getSubdirectories(dirPath: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
    } catch (error) {
      return [];
    }
  }

  private async countSubdirectories(dirPath: string): Promise<number> {
    const subdirs = await this.getSubdirectories(dirPath);
    return subdirs.length;
  }
}