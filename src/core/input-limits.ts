export const INPUT_LIMITS = {
  query: 200,
  model: 512,
  cord: 200,
  outputDir: 1_024,
} as const;

export function assertTextLength(value: string, name: string, max: number): string {
  if (value.length > max) {
    throw new Error(`${name} must be at most ${max} characters.`);
  }
  return value;
}
