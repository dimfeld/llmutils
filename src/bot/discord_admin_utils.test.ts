import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { isAdmin } from './discord_admin_utils.js';
import { error } from '../logging.js';

// Mock the error logging function
mock.module('../logging.js', () => ({
  error: mock(() => {}),
}));

// Mock the config module
let mockAdminUserIds: string | undefined = undefined;

mock.module('./config.js', () => ({
  config: new Proxy(
    {},
    {
      get(target, prop) {
        if (prop === 'ADMIN_DISCORD_USER_IDS') {
          return mockAdminUserIds;
        }
        return undefined;
      },
    }
  ),
}));

describe('isAdmin', () => {
  beforeEach(() => {
    // Reset mocks before each test
    mock.restore();
    mockAdminUserIds = undefined;
  });

  afterEach(() => {
    // Clean up after each test
    mock.restore();
  });

  it('should return true when user ID is in admin list', () => {
    mockAdminUserIds = '123456789,987654321,555555555';

    expect(isAdmin('123456789')).toBe(true);
    expect(isAdmin('987654321')).toBe(true);
    expect(isAdmin('555555555')).toBe(true);
  });

  it('should return false when user ID is not in admin list', () => {
    mockAdminUserIds = '123456789,987654321,555555555';

    expect(isAdmin('111111111')).toBe(false);
    expect(isAdmin('999999999')).toBe(false);
  });

  it('should handle spaces in the admin list', () => {
    mockAdminUserIds = '123456789 , 987654321 , 555555555';

    expect(isAdmin('123456789')).toBe(true);
    expect(isAdmin('987654321')).toBe(true);
    expect(isAdmin('555555555')).toBe(true);
  });

  it('should return false when ADMIN_DISCORD_USER_IDS is not configured', () => {
    mockAdminUserIds = undefined;

    const result = isAdmin('123456789');
    expect(result).toBe(false);
  });

  it('should return false when ADMIN_DISCORD_USER_IDS is empty string', () => {
    mockAdminUserIds = '';

    const result = isAdmin('123456789');
    expect(result).toBe(false);
  });

  it('should return false when ADMIN_DISCORD_USER_IDS contains only whitespace', () => {
    mockAdminUserIds = '   ';

    const result = isAdmin('123456789');
    expect(result).toBe(false);
  });

  it('should return false when ADMIN_DISCORD_USER_IDS contains only commas', () => {
    mockAdminUserIds = ',,,';

    const result = isAdmin('123456789');
    expect(result).toBe(false);
  });

  it('should handle single admin ID', () => {
    mockAdminUserIds = '123456789';

    expect(isAdmin('123456789')).toBe(true);
    expect(isAdmin('987654321')).toBe(false);
  });

  it('should handle trailing commas', () => {
    mockAdminUserIds = '123456789,987654321,';

    expect(isAdmin('123456789')).toBe(true);
    expect(isAdmin('987654321')).toBe(true);
  });

  it('should handle leading commas', () => {
    mockAdminUserIds = ',123456789,987654321';

    expect(isAdmin('123456789')).toBe(true);
    expect(isAdmin('987654321')).toBe(true);
  });
});
