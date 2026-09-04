/** Type declarations for the pre-startup environment validator. */

/** Parses KEY=VALUE lines without evaluating them. */
export function parseEnvFile(text: string): Record<string, string>;

/** Returns a sorted list of problems; empty means the environment is valid. */
export function validateEnvironment(env: Record<string, string>): string[];
