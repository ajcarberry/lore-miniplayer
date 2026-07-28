// Regular "+s" pluralization for the count-noun labels the surfaces render
// ("2 files", "1 commit", "3 conflicts").
export function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
