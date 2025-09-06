/**
 * Generic issue tracker interfaces to support both GitHub and Linear
 *
 * These interfaces abstract away platform-specific details to provide
 * a common API for working with issues and comments from different
 * issue tracking services.
 */

/**
 * User information for issues and comments
 */
export interface UserData {
  /** User ID (string for GitHub, string for Linear) */
  id: string;
  /** Username or login name */
  login?: string;
  /** Display name */
  name?: string;
  /** User avatar URL */
  avatarUrl?: string;
  /** Email address (if available) */
  email?: string;
}

/**
 * Generic issue data structure that works for both GitHub and Linear
 */
export interface IssueData {
  /** Unique identifier (string to support both numeric GitHub IDs and Linear UUIDs) */
  id: string;
  /** Issue number (GitHub) or key (Linear, e.g., "TEAM-123") */
  number: string | number;
  /** Issue title */
  title: string;
  /** Issue body/description */
  body?: string;
  /** URL to view the issue in the web interface */
  htmlUrl: string;
  /** Issue state (open, closed, etc.) */
  state: string;
  /** Issue creator */
  user?: UserData;
  /** Issue assignees */
  assignees?: UserData[];
  /** Issue labels/tags */
  labels?: Array<{
    id: string;
    name: string;
    color?: string;
  }>;
  /** When the issue was created */
  createdAt: string;
  /** When the issue was last updated */
  updatedAt: string;
  /** Whether this is a pull request (GitHub specific) */
  pullRequest?: boolean;
  /** Project information (if the issue belongs to a project) */
  project?: {
    /** Project name/title */
    name: string;
    /** Project description */
    description?: string;
  };
}

/**
 * Generic comment data structure for both GitHub and Linear
 */
export interface CommentData {
  /** Unique identifier */
  id: string;
  /** Comment body */
  body: string;
  /** Comment author */
  user?: UserData;
  /** When the comment was created */
  createdAt: string;
  /** When the comment was last updated */
  updatedAt?: string;
  /** URL to view the comment (if available) */
  htmlUrl?: string;
}

/**
 * Combined issue with comments data structure
 */
export interface IssueWithComments {
  /** The issue data */
  issue: IssueData;
  /** Array of comments on the issue */
  comments: CommentData[];
  /** Children issues (subissues) if fetched hierarchically */
  children?: IssueWithComments[];
}

/**
 * Parsed issue identifier information
 */
export interface ParsedIssueIdentifier {
  /** The identifier string (issue number or key) */
  identifier: string;
  /** Owner/organization name (GitHub) or workspace slug (Linear) */
  owner?: string;
  /** Repository name (GitHub) or team key (Linear) */
  repo?: string;
  /** Full URL if the spec was a URL */
  url?: string;
}

/**
 * Configuration for issue tracker instances
 */
export interface IssueTrackerConfig {
  /** The type of issue tracker */
  type: 'github' | 'linear';
  /** API key or token for authentication */
  apiKey?: string;
  /** Base URL for the API (optional, uses defaults if not provided) */
  baseUrl?: string;
  /** Additional configuration options */
  options?: Record<string, any>;
}

/**
 * Generic interface for issue tracker clients
 *
 * This interface must be implemented by both GitHub and Linear
 * clients to provide a consistent API for the application.
 */
export interface IssueTrackerClient {
  /**
   * Fetch a single issue with its comments
   * @param identifier - The issue identifier (number, key, or URL)
   * @returns Promise resolving to issue with comments
   */
  fetchIssue(identifier: string): Promise<IssueWithComments>;

  /**
   * Fetch a single issue with its comments and children (subissues) recursively
   * @param identifier - The issue identifier (number, key, or URL)
   * @returns Promise resolving to issue with comments and children
   */
  fetchIssueWithChildren?(identifier: string): Promise<IssueWithComments>;

  /**
   * Fetch all open issues (without comments)
   * @returns Promise resolving to array of issues
   */
  fetchAllOpenIssues(): Promise<IssueData[]>;

  /**
   * Parse an issue identifier and extract relevant information
   * @param spec - The issue specifier (number, key, URL, etc.)
   * @returns Parsed identifier info or null if invalid
   */
  parseIssueIdentifier(spec: string): ParsedIssueIdentifier | null;

  /**
   * Get the display name for this issue tracker type
   */
  getDisplayName(): string;

  /**
   * Get the configuration for this client
   */
  getConfig(): IssueTrackerConfig;
}

/**
 * Factory function type for creating issue tracker clients
 */
export type IssueTrackerClientFactory = (config: IssueTrackerConfig) => IssueTrackerClient;

/**
 * Registry of available issue tracker client factories
 */
export interface IssueTrackerRegistry {
  github: IssueTrackerClientFactory;
  linear: IssueTrackerClientFactory;
}
