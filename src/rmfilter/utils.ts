import { $ } from 'bun';


let cachedGitRepository: string | undefined;
export async function getGitRepository() {
  if (!cachedGitRepository) {
    let remote = (await $`git remote get-url origin`.nothrow().text()).trim();
    // Parse out therepository from the remote URL
    let lastColonIndex = remote.lastIndexOf(':');
    cachedGitRepository = remote.slice(lastColonIndex + 1).replace(/\.git$/, '');
  }

  return cachedGitRepository;
}



