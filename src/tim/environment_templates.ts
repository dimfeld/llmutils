export const TIM_ENVIRONMENT_CONTEXT_DEFINITIONS = {
  workspaceId: 'TIM_WORKSPACE_ID',
  workspaceName: 'TIM_WORKSPACE_NAME',
  workspacePath: 'TIM_WORKSPACE_PATH',
  repoPath: 'TIM_REPO_PATH',
  planId: 'TIM_PLAN_ID',
  planUuid: 'TIM_PLAN_UUID',
  planFilePath: 'TIM_PLAN_FILE_PATH',
  branch: 'TIM_BRANCH',
} as const;

export type TimEnvironmentPlaceholder = keyof typeof TIM_ENVIRONMENT_CONTEXT_DEFINITIONS;
export type TimEnvironmentBuiltInName =
  (typeof TIM_ENVIRONMENT_CONTEXT_DEFINITIONS)[TimEnvironmentPlaceholder];

export type TimEnvironmentTemplateContext = Partial<
  Record<TimEnvironmentPlaceholder, string | null | undefined>
>;

export type TimEnvironmentConfigEntry =
  | string
  | {
      value: string;
      precedence?: 'override-dotenv';
    };

export interface NormalizedTimEnvironmentConfigEntry {
  value: string;
  precedence: 'normal' | 'override-dotenv';
}

export const TIM_ENVIRONMENT_PLACEHOLDERS = Object.keys(
  TIM_ENVIRONMENT_CONTEXT_DEFINITIONS
) as TimEnvironmentPlaceholder[];

export const RESERVED_TIM_ENVIRONMENT_VARIABLES = Object.values(
  TIM_ENVIRONMENT_CONTEXT_DEFINITIONS
) as TimEnvironmentBuiltInName[];

export const RESERVED_TIM_ENVIRONMENT_VARIABLE_SET = new Set<string>(
  RESERVED_TIM_ENVIRONMENT_VARIABLES
);

export function normalizeTimEnvironmentConfigEntry(
  entry: TimEnvironmentConfigEntry
): NormalizedTimEnvironmentConfigEntry {
  if (typeof entry === 'string') {
    return { value: entry, precedence: 'normal' };
  }

  return {
    value: entry.value,
    precedence: entry.precedence ?? 'normal',
  };
}

export function renderBuiltInTimEnvironment(
  context: TimEnvironmentTemplateContext
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const placeholder of TIM_ENVIRONMENT_PLACEHOLDERS) {
    const value = context[placeholder];
    if (isAvailableTimEnvironmentContextValue(value)) {
      env[TIM_ENVIRONMENT_CONTEXT_DEFINITIONS[placeholder]] = value;
    }
  }

  return env;
}

export function renderTimEnvironmentTemplates(
  environment: Record<string, TimEnvironmentConfigEntry> | undefined,
  context: TimEnvironmentTemplateContext
): Record<string, string> {
  const rendered: Record<string, string> = {};

  for (const [variableName, entry] of Object.entries(environment ?? {})) {
    const normalized = normalizeTimEnvironmentConfigEntry(entry);
    rendered[variableName] = renderTimEnvironmentTemplate(normalized.value, context, variableName);
  }

  return rendered;
}

export function renderTimEnvironmentTemplate(
  template: string,
  context: TimEnvironmentTemplateContext,
  variableName = 'environment value'
): string {
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (_match: string, expression: string) =>
    renderTimEnvironmentExpression(expression.trim(), context, variableName)
  );
}

function renderTimEnvironmentExpression(
  expression: string,
  context: TimEnvironmentTemplateContext,
  variableName: string
): string {
  if (expression.length === 0) {
    throw new Error(`Empty TIM environment template expression in ${variableName}`);
  }

  const operands = splitFallbackOperands(expression);
  if (operands.length > 1) {
    return renderFallbackExpression(operands, context, variableName);
  }

  const operand = parseTemplateOperand(operands[0], variableName);
  if (operand.type === 'literal') {
    return operand.value;
  }

  const value = context[operand.name];
  if (!isAvailableTimEnvironmentContextValue(value)) {
    throw new Error(
      `TIM environment variable ${variableName} references unavailable placeholder ` +
        `"${operand.name}". Use a ?? fallback if this value can be unavailable.`
    );
  }

  return value;
}

function renderFallbackExpression(
  operands: string[],
  context: TimEnvironmentTemplateContext,
  variableName: string
): string {
  for (const operandExpression of operands) {
    const operand = parseTemplateOperand(operandExpression, variableName);
    if (operand.type === 'literal') {
      return operand.value;
    }

    const value = context[operand.name];
    if (isAvailableTimEnvironmentContextValue(value)) {
      return value;
    }
  }

  throw new Error(
    `TIM environment variable ${variableName} fallback expression did not resolve. ` +
      'Add an explicit quoted literal fallback.'
  );
}

function splitFallbackOperands(expression: string): string[] {
  const operands: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    const next = expression[index + 1];

    if (quote) {
      current += char;
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === '?' && next === '?') {
      operands.push(current.trim());
      current = '';
      index++;
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error('Unterminated quoted literal in TIM environment template expression');
  }

  operands.push(current.trim());
  return operands;
}

type TemplateOperand =
  | { type: 'placeholder'; name: TimEnvironmentPlaceholder }
  | { type: 'literal'; value: string };

function parseTemplateOperand(expression: string, variableName: string): TemplateOperand {
  if (expression.length === 0) {
    throw new Error(`Empty operand in TIM environment template expression for ${variableName}`);
  }

  const literal = parseQuotedLiteral(expression, variableName);
  if (literal !== null) {
    return { type: 'literal', value: literal };
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(expression)) {
    throw new Error(
      `Invalid TIM environment template operand "${expression}" in ${variableName}. ` +
        'Use a supported placeholder name or quoted literal.'
    );
  }

  if (!isTimEnvironmentPlaceholder(expression)) {
    throw new Error(
      `Unknown TIM environment placeholder "${expression}" in ${variableName}. ` +
        `Supported placeholders: ${TIM_ENVIRONMENT_PLACEHOLDERS.join(', ')}`
    );
  }

  return { type: 'placeholder', name: expression };
}

function parseQuotedLiteral(expression: string, variableName: string): string | null {
  if (expression.startsWith('"')) {
    if (!expression.endsWith('"')) {
      throw new Error(
        `Unterminated quoted literal in TIM environment template expression for ${variableName}`
      );
    }
    try {
      return JSON.parse(expression) as string;
    } catch (cause) {
      throw new Error(
        `Invalid quoted literal in TIM environment template expression for ${variableName}`,
        { cause }
      );
    }
  }

  if (expression.startsWith("'")) {
    if (!expression.endsWith("'")) {
      throw new Error(
        `Unterminated quoted literal in TIM environment template expression for ${variableName}`
      );
    }
    return expression.slice(1, -1).replace(/\\'/g, "'");
  }

  return null;
}

function isTimEnvironmentPlaceholder(value: string): value is TimEnvironmentPlaceholder {
  return Object.hasOwn(TIM_ENVIRONMENT_CONTEXT_DEFINITIONS, value);
}

export function isAvailableTimEnvironmentContextValue(
  value: string | null | undefined
): value is string {
  return typeof value === 'string' && value.length > 0;
}
