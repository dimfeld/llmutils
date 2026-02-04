// Command handler for 'tim shell-integration'
// Generates shell functions for interactive workspace switching using fzf

export type ShellType = 'bash' | 'zsh';

export interface ShellIntegrationOptions {
  shell?: ShellType;
}

/**
 * Generates and prints a shell function for workspace switching.
 * The function uses fzf to interactively select a workspace and cd into it.
 */
export function handleShellIntegrationCommand(options: ShellIntegrationOptions): void {
  const shell: ShellType = options.shell ?? 'zsh';
  const functionCode = generateShellFunction(shell);
  console.log(functionCode);
}

/**
 * Generates the shell function code for workspace switching.
 * Exported for testing.
 */
export function generateShellFunction(shell: ShellType): string {
  // The function works the same for bash and zsh, but we include
  // shell-specific comments and shebang recommendations
  const shellComment = shell === 'bash' ? '# Bash' : '# Zsh';

  return `${shellComment} function for tim workspace switching
# Add this to your ~/.${shell}rc or source it from a file
#
# Usage:
#   tim_ws          - Interactive workspace selection
#   tim_ws <query>  - Pre-filter workspaces matching query

tim_ws() {
  # Check if fzf is installed
  if ! command -v fzf >/dev/null 2>&1; then
    echo "Error: fzf is not installed. Please install fzf to use workspace switching." >&2
    return 1
  fi

  # Get the list of workspaces in TSV format (2 columns: path, formatted description)
  local workspace_list
  workspace_list=$(tim workspace list --format tsv --no-header 2>/dev/null)

  if [ -z "$workspace_list" ]; then
    echo "No workspaces found." >&2
    return 1
  fi

  # Build fzf command with optional query
  # TSV format: fullPath<tab>formattedDescription
  # Display only the formatted description (field 2), use field 1 for selection
  local fzf_args=(
    --delimiter $'\\t'
    --with-nth '2'
    --preview 'echo "Path: {1}"'
    --preview-window 'up:1:wrap'
    --header 'Select a workspace (Esc to cancel)'
  )

  # Add query if provided as argument
  if [ -n "$1" ]; then
    fzf_args+=(--query "$1")
  fi

  # Run fzf and extract the selected path
  local selected
  selected=$(echo "$workspace_list" | fzf "\${fzf_args[@]}")

  # Handle cancellation (exit code 130) or empty selection
  local exit_code=$?
  if [ $exit_code -eq 130 ] || [ -z "$selected" ]; then
    return 0
  fi

  if [ $exit_code -ne 0 ]; then
    echo "fzf exited with error code $exit_code" >&2
    return $exit_code
  fi

  # Extract the full path (first field)
  local workspace_path
  workspace_path=$(echo "$selected" | cut -f1)

  if [ -n "$workspace_path" ] && [ -d "$workspace_path" ]; then
    cd "$workspace_path" || return 1
    echo "Switched to: $workspace_path"
  else
    echo "Error: Invalid workspace path: $workspace_path" >&2
    return 1
  fi
}
`;
}
