import type { Octokit } from 'octokit';

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  botName: string;
  port?: number;
}

export interface WebhookEvent {
  action: string;
  issue?: {
    number: number;
    title: string;
    body: string;
    html_url: string;
    user: {
      login: string;
    };
    labels: Array<{
      name: string;
    }>;
    created_at: string;
    updated_at: string;
  };
  pull_request?: {
    number: number;
    title: string;
    body: string;
    html_url: string;
  };
  comment?: {
    id: number;
    body: string;
    user: {
      login: string;
    };
  };
  repository: {
    owner: {
      login: string;
    };
    name: string;
    clone_url: string;
    default_branch?: string;
  };
  installation?: {
    id: number;
  };
}

export interface ParsedCommand {
  command: string;
  args: string[];
  options: Record<string, string | boolean>;
  contextFiles?: string[];
}

export interface ExecutionContext {
  octokit: Octokit;
  event: WebhookEvent;
  workspaceDir: string;
  command: ParsedCommand;
}
