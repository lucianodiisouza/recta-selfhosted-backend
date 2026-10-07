// Runs once in the main vitest process, before any worker starts, so the workers inherit it and it wins over a TZ
// exported by the shell or the CI runner. Date-only bugs (a local-time Date truncated to the UTC day by Prisma) only
// show in a time zone behind UTC; on a UTC machine such a test would pass with the bug in place.
export default function setup() {
  process.env.TZ = 'America/Sao_Paulo';
}
