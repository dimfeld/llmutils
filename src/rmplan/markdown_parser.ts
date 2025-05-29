import { marked } from 'marked';

export interface ParsedTask {
  title: string;
  description: string;
}

export interface ParsedPhase {
  title: string;
  numericIndex: number; // Extracted from "Phase X"
  goal: string;
  dependencies: string[]; // Raw dependency strings, e.g., "Phase 1", "Phase 2"
  details: string;
  tasks: ParsedTask[];
}

export interface ParsedMarkdownPlan {
  overallGoal: string;
  overallDetails: string;
  phases: ParsedPhase[];
  rmfilter?: string[]; // Placeholder for now, if we decide to parse it from MD
}

export async function parseMarkdownPlan(markdownContent: string): Promise<ParsedMarkdownPlan> {
  const tokens = marked.lexer(markdownContent);

  let overallGoal = '';
  let overallDetails = '';
  const phases: ParsedPhase[] = [];

  let currentPhase: ParsedPhase | null = null;
  let currentTask: ParsedTask | null = null;
  let isInGoalSection = false;
  let isInDetailsSection = false;
  let isInPhaseGoal = false;
  let isInPhaseDependencies = false;
  let isInPhaseDetails = false;
  let isInTaskDescription = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === 'heading') {
      // Reset section flags
      isInGoalSection = false;
      isInDetailsSection = false;
      isInPhaseGoal = false;
      isInPhaseDependencies = false;
      isInPhaseDetails = false;
      isInTaskDescription = false;

      if (token.depth === 1 && token.text === 'Goal') {
        isInGoalSection = true;
      } else if (token.depth === 2 && token.text === 'Details') {
        isInDetailsSection = true;
      } else if (token.depth === 3) {
        // Check for phase header: ### Phase X: [Title]
        const phaseMatch = token.text.match(/^Phase (\d+):\s*(.+)$/);
        if (phaseMatch) {
          // Save current task to current phase before starting new phase
          if (currentPhase) {
            if (currentTask) {
              currentPhase.tasks.push(currentTask);
              currentTask = null;
            }
            phases.push(currentPhase);
          }

          currentPhase = {
            title: phaseMatch[2].trim(),
            numericIndex: parseInt(phaseMatch[1], 10),
            goal: '',
            dependencies: [],
            details: '',
            tasks: [],
          };
        }
      } else if (token.depth === 4 && currentPhase) {
        if (token.text === 'Goal') {
          isInPhaseGoal = true;
        } else if (token.text === 'Dependencies') {
          isInPhaseDependencies = true;
        } else if (token.text === 'Details') {
          isInPhaseDetails = true;
        }
      } else if (token.depth === 5 && currentPhase) {
        // Check for task header: ##### Task: [Task Title]
        const taskMatch = token.text.match(/^Task:\s*(.+)$/);
        if (taskMatch) {
          if (currentTask) {
            currentPhase.tasks.push(currentTask);
          }

          currentTask = {
            title: taskMatch[1].trim(),
            description: '',
          };
          isInTaskDescription = true;
        }
      }
    } else if (token.type === 'paragraph') {
      const text = token.text;

      if (isInGoalSection) {
        overallGoal = overallGoal ? overallGoal + '\n\n' + text : text;
      } else if (isInDetailsSection) {
        overallDetails = overallDetails ? overallDetails + '\n\n' + text : text;
      } else if (currentPhase) {
        if (isInPhaseGoal) {
          currentPhase.goal = currentPhase.goal ? currentPhase.goal + '\n\n' + text : text;
        } else if (isInPhaseDependencies) {
          // Parse dependencies
          const deps = text
            .split(',')
            .map((d: string) => d.trim())
            .filter((d: string) => d && d.toLowerCase() !== 'none');
          currentPhase.dependencies = deps;
        } else if (isInPhaseDetails) {
          currentPhase.details = currentPhase.details ? currentPhase.details + '\n\n' + text : text;
        } else if (isInTaskDescription && currentTask) {
          // Check if it starts with **Description:**
          if (text.startsWith('**Description:**')) {
            currentTask.description = text.replace(/^\*\*Description:\*\*\s*/, '').trim();
          } else if (currentTask.description) {
            // Continue previous task description
            currentTask.description += '\n\n' + text;
          }
        }
      }
    }
  }

  // Save the last task and phase if exists
  if (currentPhase) {
    if (currentTask && !currentPhase.tasks.some((t) => t.title === currentTask.title)) {
      currentPhase.tasks.push(currentTask);
    }
    phases.push(currentPhase);
  }

  // Single-Phase Fallback
  if (phases.length === 0) {
    // Look for tasks in the remaining content
    const tasks: ParsedTask[] = [];
    let currentFallbackTask: ParsedTask | null = null;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      if (token.type === 'heading' && token.depth === 5) {
        const taskMatch = token.text.match(/^Task:\s*(.+)$/);
        if (taskMatch) {
          if (currentFallbackTask) {
            tasks.push(currentFallbackTask);
          }
          currentFallbackTask = {
            title: taskMatch[1].trim(),
            description: '',
          };
        }
      } else if (token.type === 'paragraph' && currentFallbackTask) {
        if (token.text.startsWith('**Description:**')) {
          currentFallbackTask.description = token.text
            .replace(/^\*\*Description:\*\*\s*/, '')
            .trim();
        }
      }
    }

    if (currentFallbackTask) {
      tasks.push(currentFallbackTask);
    }

    // If no tasks found, create a default one
    if (tasks.length === 0) {
      tasks.push({
        title: overallGoal || 'Implement feature',
        description:
          overallDetails || 'Complete the implementation as described in the overall goal.',
      });
    }

    // Create single phase
    phases.push({
      numericIndex: 1,
      title: 'Implementation',
      goal: overallGoal || 'Complete the implementation',
      dependencies: [],
      details: overallDetails || '',
      tasks: tasks,
    });
  }

  return {
    overallGoal,
    overallDetails,
    phases,
    rmfilter: undefined,
  };
}
