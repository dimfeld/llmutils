/**
 * Issue tracker abstraction module
 *
 * This module provides generic interfaces and types for working with
 * different issue tracking services like GitHub and Linear.
 */

// Export all types
export type {
  UserData,
  IssueData,
  CommentData,
  IssueWithComments,
  ParsedIssueIdentifier,
  IssueTrackerConfig,
  IssueTrackerClient,
  IssueTrackerClientFactory,
  IssueTrackerRegistry,
} from './types.js';
