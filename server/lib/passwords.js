import argon2 from 'argon2';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1
};

export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  if (plain.length > 1024) {
    throw new Error('Password is too long.');
  }
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hash, plain) {
  if (!hash || typeof plain !== 'string') return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

const COMMON = new Set([
  'password', 'password1', 'qwerty123', '12345678', '123456789',
  'abc12345', 'letmein1', 'iloveyou1', 'welcome1', 'admin123'
]);

export function passwordStrengthIssues(password) {
  const issues = [];
  if (typeof password !== 'string') return ['Password is required.'];
  if (password.length < 10) issues.push('Use at least 10 characters.');
  if (!/[a-z]/.test(password)) issues.push('Include a lowercase letter.');
  if (!/[A-Z]/.test(password)) issues.push('Include an uppercase letter.');
  if (!/[0-9]/.test(password)) issues.push('Include a number.');
  if (COMMON.has(password.toLowerCase())) issues.push('Choose a less common password.');
  return issues;
}
