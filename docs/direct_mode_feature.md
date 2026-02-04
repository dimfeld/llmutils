# Direct Mode Configuration

The `planning.direct_mode` configuration option allows you to set "direct" mode as the default behavior for the `tim generate` and `tim prepare` commands. This feature improves workflow customization by letting you configure your preferred execution mode.

## Purpose

The direct mode configuration option provides:

- Default behavior control for `generate` and `prepare` commands
- Elimination of repetitive command-line flag usage
- Consistent workflow configuration across team members
- Easy toggling between planning modes

## Configuration

### Setting Direct Mode in tim.yml

To enable direct mode by default, add the `planning.direct_mode` option to your `tim.yml` configuration file:

```yaml
# tim.yml
planning:
  direct_mode: true
```

When set to `true`, both `tim generate` and `tim prepare` will execute in direct mode by default, meaning they will immediately execute the plan without interactive review.

### Default Behavior

If the `planning.direct_mode` option is not specified in your configuration file, or if it's set to `false`, the commands will operate in their standard interactive mode:

```yaml
# tim.yml
planning:
  direct_mode: false # This is the default if not specified
```

## Command-Line Override Precedence

The configuration setting can always be overridden using command-line flags, following this precedence order:

1. **Command-line flags** (highest priority)
2. **Configuration file setting**
3. **Default behavior** (non-direct mode)

### Override Examples

#### Forcing Non-Direct Mode

When `direct_mode: true` is set in the configuration, you can still run in interactive mode using the `--no-direct` flag:

```bash
# Configuration has direct_mode: true, but we want interactive mode for this run
tim generate --no-direct --plan new-feature.md -- src/**/*.ts
```

#### Forcing Direct Mode

When `direct_mode: false` (or not set), you can still run in direct mode using the `--direct` flag:

```bash
# Configuration has direct_mode: false, but we want direct mode for this run
tim prepare --direct tasks/bug-fix.yml
```

## Use Cases

### Team Standardization

Teams can standardize their workflow by setting a default mode in the shared configuration:

```yaml
# tim.yml - shared team configuration
planning:
  direct_mode: true # Team prefers immediate execution
```

### Development vs Production

You might use different configurations for different environments:

```yaml
# tim.dev.yml - development configuration
planning:
  direct_mode: false  # Interactive review during development

# tim.prod.yml - production configuration
planning:
  direct_mode: true   # Automated execution in CI/CD
```

## Complete Configuration Example

Here's a complete `tim.yml` example showing the direct mode setting alongside other configuration options:

```yaml
# tim.yml
tasks_directory: ./tasks
default_model: claude-3-5-sonnet-20241022
default_executor: claude_code

planning:
  direct_mode: true # Enable direct mode by default


# Other configuration options...
```

## Related Commands

The `planning.direct_mode` configuration affects these commands:

- `tim generate` - Generates new project plans from requirements
- `tim prepare` - Prepares context and execution for existing plans

Both commands respect the same precedence rules and override flags when direct mode is configured.
