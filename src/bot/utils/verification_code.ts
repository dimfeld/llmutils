import crypto from 'node:crypto';

/**
 * Generates a secure verification code for user registration.
 * Creates a 6-character alphanumeric code that is case-insensitive friendly.
 *
 * @returns A 6-character verification code
 */
export function generateVerificationCode(): string {
  // Use uppercase letters and numbers (no ambiguous characters like 0/O, 1/I/L)
  const charset = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';

  // Generate 6 random characters
  for (let i = 0; i < 6; i++) {
    const randomIndex = crypto.randomInt(0, charset.length);
    code += charset[randomIndex];
  }

  return code;
}

/**
 * Gets the expiration time for a verification code.
 * Default is 10 minutes from now.
 *
 * @param minutesFromNow Number of minutes until expiration (default: 10)
 * @returns Date object representing when the code expires
 */
export function getVerificationCodeExpiration(minutesFromNow: number = 10): Date {
  return new Date(Date.now() + minutesFromNow * 60 * 1000);
}
