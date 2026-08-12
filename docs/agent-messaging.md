# Agent Messaging Foundation

Contributor guidance for the agent-messaging domain: the shared vocabulary that
lets an orchestrator address, message, and stop its subagents.

**Status: dormant.** This layer currently holds only configuration, contracts,
and identity helpers. No tool, socket, registry, temporary directory, prompt,
provider session, or process label uses it yet. A run with the flag on behaves
exactly like a run with it off. Later plans add the runtime on top of these
contracts; keep the contracts as the single source of truth instead of
redefining enums, names, or limits in a provider adapter.

Relevant code:

- `src/tim/agent_messaging/contracts.ts` — provider-neutral constants, enums,
  Zod schemas, inferred types, and lifecycle classification helpers.
- `src/tim/agent_messaging/environment.ts` — internal per-process identity
  variables, the identity union, and pure read/write helpers.
- `src/tim/configSchema.ts` — the `experimental.agentMessaging` flag.
- `src/tim/configLoader.ts` — nested merge of the `experimental` block.

## The experimental flag

`experimental.agentMessaging` is an optional boolean with **no schema default**.
The canonical enabled check is exact:

```ts
const agentMessagingEnabled = config.experimental?.agentMessaging === true;
```

`mergeConfigs()` merges `experimental` as a nested object, so a local layer can
override `agentMessaging` without dropping unrelated experimental keys.

`src/tim/commands/agent/agent.ts` takes **one** snapshot of the resolved boolean
per root session and puts it in `ExecutorCommonOptions.agentMessagingEnabled`
(`src/tim/executors/types.ts`). Both orchestration entry points forward it into
`OrchestrationOptions` (`src/tim/executors/shared/orchestration_options.ts`):
`claude_code.ts` and `codex_cli/orchestrator_mode.ts`. Nothing reads it. Read the
snapshot rather than the config again in later work, so one session cannot
change mode mid-run.

## Contract vocabulary

Keep these words distinct; they are not interchangeable.

| Term    | Meaning                                           |
| ------- | ------------------------------------------------- |
| `name`  | Model-facing address used by the tools            |
| `id`    | Opaque runtime identity                           |
| `type`  | Work role of a subagent                           |
| `role`  | Authorization class: `orchestrator` or `subagent` |
| `state` | Lifecycle state                                   |

- Agent types: `implementer`, `tester`, `tdd-tests`, `reviewer`. The
  orchestrator is **not** a fifth type — it is a role.
- Executors: `claude-code`, `codex-cli`.
- Lifecycle states: nonterminal `starting`, `running-active`, `running-idle`,
  `finishing`, `stopping`; terminal `exited`, `failed`. Use
  `isNonterminalAgentLifecycleState()` / `isTerminalAgentLifecycleState()` for
  classification (for example, the subagent limit and `ListAgents` filtering
  count only nonterminal agents).
- Send acknowledgements: `steered`, `queued`, `started-idle-turn`.
- Stop acknowledgements: `graceful-requested`, `forced`, `already-stopping`.

### Names

An agent name is 1 to 48 characters of lowercase ASCII letters, digits, and
hyphens, with alphanumeric first and last characters. Consecutive hyphens are
allowed. Comparison is exact and case-sensitive: uppercase input is invalid, and
validation never lowercases or trims silently.

Two schemas share the grammar:

- `agentAddressSchema` — any target, including the reserved `orchestrator`
  address. Used by `SendAgentMessage`.
- `agentNameSchema` — rejects `orchestrator`. Used where a custom subagent name
  is required (`StartAgent`, `StopAgent`).

Default `<type>-<short-slug>` name generation and collision reservation belong
to the later registry, not to this module.

### Limits

| Constant                             | Value  | Meaning                                |
| ------------------------------------ | ------ | -------------------------------------- |
| `MAX_AGENT_NAME_LENGTH`              | 48     | Name characters                        |
| `MAX_SUBAGENTS_PER_SESSION`          | 8      | Nonterminal subagents per root session |
| `MAX_AGENT_MESSAGE_BYTES`            | 65,536 | Message content, in UTF-8 **bytes**    |
| `MAX_PENDING_MESSAGES_PER_RECIPIENT` | 100    | Queued messages for one recipient      |

The reserved orchestrator identity does not count against the subagent limit.
`agentMessageContentSchema` measures UTF-8 bytes with `utf8ByteLength()`, not
JavaScript string length; exactly 65,536 bytes is accepted and one more byte is
rejected without truncation. Mailbox framing and any JSONL frame limit belong to
the transport layer and must build on this message limit.

## Tool schemas

Strict, provider-neutral schemas and inferred types exist for the arguments and
success results of `StartAgent`, `ListAgents`, `SendAgentMessage`, `StopAgent`,
and `FinishAgent`. They carry no MCP or JSON-RPC wrapper and no provider result
blocks, so the Claude MCP adapter and the Codex dynamic-tool adapter can
serialize the same values. Provider adapters convert Zod failures into their own
tool-error format.

`ListAgents` returns a union discriminated on `role`: an orchestrator row has
the literal name `orchestrator` and no `type`; a subagent row has `role:
'subagent'` and one of the four types.

**Identity is never a model argument.** `SendAgentMessage` has no `source` /
`sourceName` / `caller` field, `StopAgent` has no caller-role field, and
`FinishAgent` has no target field — it acts on the calling agent only. The
runtime binds the caller internally; putting identity in the arguments would
make spoofing part of the public contract. All argument schemas are `.strict()`,
so such a field fails validation.

## Internal identity environment

Five internal variables carry per-process identity:
`TIM_AGENT_MESSAGING_DIR`, `TIM_AGENT_ID`, `TIM_AGENT_NAME`, `TIM_AGENT_TYPE`,
`TIM_AGENT_ROLE`. The orchestrator uses name `orchestrator`, role
`orchestrator`, and no type; a subagent adds one of the four types.

- `withAgentEnvironmentIdentity(inheritedEnv, identity)` returns a **copy** with
  the identity applied. It drops a stale `TIM_AGENT_TYPE` when writing an
  orchestrator identity.
- `readAgentEnvironmentIdentity(env)` returns `undefined` when all five values
  are absent, the typed identity when the combination is complete, and throws
  when any value is present but the combination is incomplete or contradictory
  (for example role `subagent` without a type).
- Neither helper mutates global `process.env`. Compose env per process.

These names are **reserved but not public**: they join
`RESERVED_TIM_ENVIRONMENT_VARIABLES` so project `environment` config cannot
spoof them, and they stay out of `TIM_ENVIRONMENT_CONTEXT_DEFINITIONS` and
`renderBuiltInTimEnvironment()`. See
[project-environment.md](project-environment.md#reserved-built-ins-vs-process-control-variables).
No process receives these variables yet.

## Boundaries to keep

- Do not import Claude MCP types, Codex app-server types, tunnel protocol types,
  session-server types, or provider implementations into
  `src/tim/agent_messaging/`.
- Do not give the config flag a Zod default, and do not shallow-replace the
  whole `experimental` object during merge.
- Do not add conditional prompt text, tool installation, or provider lifetime
  changes while the flag is dormant.
