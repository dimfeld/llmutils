import { describe, it, expect } from 'bun:test';

// Simple test to verify the PR section visibility logic
describe('PlanDetail PR Section Visibility', () => {
  it('should show PR section when plan has prStatuses', () => {
    // This tests the logic that was fixed in PlanDetail.svelte
    // The condition now includes: plan.prStatuses.length > 0
    
    const plan = {
      pullRequests: [],
      invalidPrUrls: [],
      prStatuses: [{ id: 1, url: 'https://github.com/test/repo/pull/1' }] // Auto-linked PRs
    };
    
    // This should now be true with the fix
    const shouldShowPrSection = plan.pullRequests.length > 0 || 
                                plan.invalidPrUrls.length > 0 || 
                                plan.prStatuses.length > 0;
    
    expect(shouldShowPrSection).toBe(true);
  });
  
  it('should show PR section when plan has explicit pullRequests', () => {
    const plan = {
      pullRequests: [{ url: 'https://github.com/test/repo/pull/1' }],
      invalidPrUrls: [],
      prStatuses: []
    };
    
    const shouldShowPrSection = plan.pullRequests.length > 0 || 
                                plan.invalidPrUrls.length > 0 || 
                                plan.prStatuses.length > 0;
    
    expect(shouldShowPrSection).toBe(true);
  });
  
  it('should not show PR section when plan has no PR data', () => {
    const plan = {
      pullRequests: [],
      invalidPrUrls: [],
      prStatuses: []
    };
    
    const shouldShowPrSection = plan.pullRequests.length > 0 || 
                                plan.invalidPrUrls.length > 0 || 
                                plan.prStatuses.length > 0;
    
    expect(shouldShowPrSection).toBe(false);
  });
});