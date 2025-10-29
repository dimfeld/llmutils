---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
title: Add blocking subissues feature to generate command
goal: ""
id: 135
uuid: ac0b9e9d-cd95-45f1-8ded-15074bd6c800
generatedBy: agent
status: pending
priority: medium
temp: false
dependencies:
  - 129
parent: 128
planGeneratedAt: 2025-10-26T23:05:27.414Z
promptsGeneratedAt: 2025-10-26T23:05:27.414Z
createdAt: 2025-10-26T22:41:26.645Z
updatedAt: 2025-10-27T08:39:04.208Z
tasks:
  - title: Add CLI Flag
    done: false
    description: Add `--with-blocking-subissues` flag to generate command in
      `src/rmplan/rmplan.ts`
  - title: Update Generate Command Prompt
    done: false
    description: Modify `src/rmplan/commands/generate.ts` to add blocking subissues
      section to the LLM prompt when the flag is enabled. Include instructions
      for the LLM to identify prerequisites and format them appropriately.
  - title: Update MCP Generate Prompts
    done: false
    description: >-
      Update the generate MCP prompts in `src/rmplan/mcp/generate_mode.ts` to
      include instructions about identifying and creating blocking subissues.
      Specifically update:

      - `loadResearchPrompt` to mention identifying blocking work during
      research

      - `loadGeneratePrompt` to include the blocking subissue format and
      instructions


      The prompts should instruct Claude to identify prerequisite work and
      consider creating separate plans for complex prerequisites with proper
      dependencies.
  - title: Parse and Create Subissues
    done: false
    description: Implement parsing logic to extract blocking subissue information
      from LLM output. Add interactive prompt to ask user if they want to create
      the identified subissues as separate plans. Create the plans
      programmatically using appropriate functions and update dependencies.
  - title: Add discoveredFrom Tracking
    done: false
    description: When creating blocking subissue plans, use the `--discovered-from`
      field to link them back to the parent plan that identified them. This
      requires plan 129 to be completed first.
  - title: Add Tests
    done: false
    description: |-
      Write tests covering:
      - Prompt generation with flag enabled
      - Parsing of blocking subissues from LLM output
      - User accepts creation: plans created with correct fields
      - User declines creation: no plans created
      - Dependencies correctly added to parent plan
      - discoveredFrom field is set correctly
---

## Overview

Enhance `rmplan generate` to help agents identify prerequisite work that should be done first. This adds a `--with-blocking-subissues` flag that prompts the LLM to identify blocking work, then offers to create those as separate plans with proper dependencies.

## Changes Required

### 1. Add CLI Flag

File: `src/rmplan/rmplan.ts` (in the generate command definition)

```typescript
.option('--with-blocking-subissues', 'Prompt LLM to identify and create blocking prerequisite plans')
```

### 2. Update Prompt Generation

File: `src/rmplan/commands/generate.ts`

When `options.withBlockingSubissues` is true, add this section to the LLM prompt:

```markdown
# Blocking Subissues

Before proposing the main implementation tasks, identify any prerequisite work
that should be completed first. For each prerequisite:
1. Determine if it should be a separate plan
2. Suggest a title, priority, and relationship to this plan
3. Explain why it's a prerequisite

Format blocking subissues as:
## Blocking Subissue: [Title]
- Priority: [high|medium|low]
- Relationship: [dependency|research|infrastructure]
- Reason: [Why this must be done first]
- Tasks: [High-level task list]
```

### 3. Parse and Create Subissues

After the LLM responds, parse the blocking subissues section:

```typescript
const blockingRegex = /## Blocking Subissue: (.+?)\n- Priority: (.+?)\n- Relationship: (.+?)\n- Reason: (.+?)\n- Tasks: ([\s\S]+?)(?=## Blocking Subissue:|$)/g;

const subissues = [];
let match;
while ((match = blockingRegex.exec(llmOutput)) !== null) {
  subissues.push({
    title: match[1].trim(),
    priority: match[2].trim(),
    relationship: match[3].trim(),
    reason: match[4].trim(),
    tasks: match[5].trim(),
  });
}
```

Then offer to create them:

```typescript
if (subissues.length > 0) {
  log(chalk.yellow(`\nLLM identified ${subissues.length} blocking subissues`));
  
  const shouldCreate = await confirm({
    message: 'Create these as separate plans?',
    default: true,
  });
  
  if (shouldCreate) {
    const createdIds = [];
    for (const subissue of subissues) {
      // Create plan using rmplan add command programmatically
      const newPlanId = await createPlan({
        title: subissue.title,
        priority: subissue.priority,
        parent: currentPlanId, // if this is part of a hierarchy
        details: `${subissue.reason}\n\n## Tasks\n${subissue.tasks}`,
      });
      createdIds.push(newPlanId);
    }
    
    // Add created plan IDs as dependencies to current plan
    await updatePlanDependencies(currentPlanId, createdIds);
    
    log(chalk.green(`✓ Created ${createdIds.length} blocking plans: ${createdIds.join(', ')}`));
  }
}
```

## Example Usage

```bash
# Generate plan with blocking subissue detection
rmplan generate 42 --with-blocking-subissues
```

LLM might respond:

```
## Blocking Subissue: Set up authentication infrastructure
- Priority: high
- Relationship: infrastructure
- Reason: The main tasks require auth middleware which doesn't exist yet
- Tasks:
  1. Install passport.js and configure strategies
  2. Create auth middleware
  3. Add user session management

## Blocking Subissue: Research rate limiting approaches
- Priority: medium  
- Relationship: research
- Reason: Need to decide on rate limiting strategy before implementing endpoints
- Tasks:
  1. Compare redis-based vs in-memory solutions
  2. Document decision and rationale
```

Then the command would offer to create plans 143 (auth infrastructure) and 144 (research), and update plan 42 to depend on them.

## Use Case

This helps agents:
1. Break down work more granularly
2. Avoid starting implementation before prerequisites are ready
3. Track why certain work needs to happen in a specific order
4. Use `discoveredFrom` to link the subissues back to the parent plan

## Testing

- Generate with flag, verify prompt includes blocking subissue section
- Mock LLM response with subissues, verify parsing works
- Accept creation prompt, verify plans are created with correct fields
- Decline creation prompt, verify plans are not created
- Verify dependencies are added correctly to parent plan

## Dependencies

Depends on plan 129 for `discoveredFrom` field (subissues should be marked with `--discovered-from <parent-plan-id>`).
