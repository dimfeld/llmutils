import { describe, expect, it } from 'bun:test';
import {
  deriveRepositoryName,
  fallbackRepositoryNameFromGitRoot,
  parseGitRemoteUrl,
} from './git_url_parser';

describe('parseGitRemoteUrl', () => {
  it('parses HTTPS GitHub remotes', () => {
    const parsed = parseGitRemoteUrl('https://github.com/owner/repo.git');
    expect(parsed).not.toBeNull();
    expect(parsed?.protocol).toBe('https');
    expect(parsed?.host).toBe('github.com');
    expect(parsed?.fullName).toBe('owner/repo');
    expect(parsed?.repository).toBe('repo');
    expect(parsed?.service).toBe('github');
  });

  it('parses SCP-style SSH remotes', () => {
    const parsed = parseGitRemoteUrl('git@github.com:owner/repo.git');
    expect(parsed).not.toBeNull();
    expect(parsed?.protocol).toBe('ssh');
    expect(parsed?.host).toBe('github.com');
    expect(parsed?.fullName).toBe('owner/repo');
    expect(parsed?.repository).toBe('repo');
  });

  it('parses SCP-style SSH remotes without usernames', () => {
    const parsed = parseGitRemoteUrl('example.com:owner/repo.git');
    expect(parsed).not.toBeNull();
    expect(parsed?.protocol).toBe('ssh');
    expect(parsed?.host).toBe('example.com');
    expect(parsed?.username).toBeUndefined();
    expect(parsed?.fullName).toBe('owner/repo');
    expect(parsed?.repository).toBe('repo');
  });

  it('parses GitLab remotes with subgroups', () => {
    const parsed = parseGitRemoteUrl('git@gitlab.com:group/sub/repo.git');
    expect(parsed).not.toBeNull();
    expect(parsed?.fullName).toBe('group/sub/repo');
    expect(parsed?.repository).toBe('repo');
    expect(parsed?.ownerPath).toBe('group/sub');
    expect(parsed?.service).toBe('gitlab');
  });

  it('parses Bitbucket remotes with credentials in the URL', () => {
    const parsed = parseGitRemoteUrl('https://user@bitbucket.org/workspace/project.git');
    expect(parsed).not.toBeNull();
    expect(parsed?.protocol).toBe('https');
    expect(parsed?.host).toBe('bitbucket.org');
    expect(parsed?.service).toBe('bitbucket');
    expect(parsed?.fullName).toBe('workspace/project');
    expect(parsed?.username).toBe('user');
  });

  it('handles HTTPS remotes without .git suffix and trailing slashes', () => {
    const parsed = parseGitRemoteUrl('https://gitlab.example.com/group/repo/');
    expect(parsed).not.toBeNull();
    expect(parsed?.repository).toBe('repo');
    expect(parsed?.fullName).toBe('group/repo');
    expect(parsed?.service).toBe('gitlab');
  });

  it('captures custom ports for SSH URLs', () => {
    const parsed = parseGitRemoteUrl('ssh://git@example.org:2222/team/project.git');
    expect(parsed).not.toBeNull();
    expect(parsed?.host).toBe('example.org');
    expect(parsed?.port).toBe(2222);
    expect(parsed?.fullName).toBe('team/project');
    expect(parsed?.service).toBe('unknown');
  });

  it('decodes and normalizes percent-encoded path components', () => {
    const parsed = parseGitRemoteUrl('https://gitlab.com/team/sub%20group/awesome%20repo.git');
    expect(parsed).not.toBeNull();
    expect(parsed?.fullName).toBe('team/sub group/awesome repo');
    expect(parsed?.pathSegments).toEqual(['team', 'sub group', 'awesome repo']);
  });

  it('handles local filesystem paths', () => {
    const parsed = parseGitRemoteUrl('../relative/path/to/repo.git');
    expect(parsed).not.toBeNull();
    expect(parsed?.protocol).toBe('file');
    expect(parsed?.host).toBeUndefined();
    expect(parsed?.repository).toBe('repo');
    expect(parsed?.fullName).toBe('../relative/path/to/repo');
  });

  it('normalizes Windows-style local filesystem paths', () => {
    const parsed = parseGitRemoteUrl('C:\\Users\\dev\\Project Repo.git');
    expect(parsed).not.toBeNull();
    expect(parsed?.protocol).toBe('file');
    expect(parsed?.path).toBe('C:/Users/dev/Project Repo.git');
    expect(parsed?.repository).toBe('Project Repo');
  });

  it('returns null for empty remote strings', () => {
    expect(parseGitRemoteUrl('   ')).toBeNull();
  });
});

describe('deriveRepositoryName', () => {
  it('builds filesystem-safe name for hosted repositories', () => {
    const parsed = parseGitRemoteUrl('git@github.com:Owner-Name/project.git');
    const derived = deriveRepositoryName(parsed);
    expect(derived).toBe('github.com__Owner-Name__project');
  });

  it('includes port information when present', () => {
    const parsed = parseGitRemoteUrl('ssh://git@host.example.com:2200/team/project.git');
    const derived = deriveRepositoryName(parsed);
    expect(derived).toBe('host.example.com__port-2200__team__project');
  });

  it('falls back to provided name when no remote information is available', () => {
    const derived = deriveRepositoryName(null, { fallbackName: 'My Repo' });
    expect(derived).toBe('My-Repo');
  });

  it('respects maximum length by hashing overflow', () => {
    const parsed = parseGitRemoteUrl('https://github.com/owner/very-long-project-name.git');
    const derived = deriveRepositoryName(parsed, { maxLength: 16 });
    expect(derived.length).toBeLessThanOrEqual(16);
    expect(derived).toMatch(/-[0-9a-f]{8}$/);
  });

  it('sanitizes complex path segments into filesystem-safe names', () => {
    const parsed = parseGitRemoteUrl('https://gitlab.example.com/Team Space/Project.Name.git');
    const derived = deriveRepositoryName(parsed);
    expect(derived).toBe('gitlab.example.com__Team-Space__Project.Name');
  });

  it('derives names from fallback paths with nested segments', () => {
    const derived = deriveRepositoryName(null, { fallbackName: 'clients/acme corp/project one' });
    expect(derived).toBe('clients__acme-corp__project-one');
  });
});

describe('fallbackRepositoryNameFromGitRoot', () => {
  it('sanitizes directory basenames', () => {
    const name = fallbackRepositoryNameFromGitRoot('/tmp/example repo');
    expect(name).toBe('example-repo');
  });
});
