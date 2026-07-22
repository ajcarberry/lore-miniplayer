// Bootstraps a purely-local, offline Lore repository (a real `.lore/` dir) as
// an e2e fixture — no live Lore server involved. Per P1's finding (spec.md's
// "P1 Findings", offline repo bootstrap): `repositoryCreate` works fully
// offline with `offline:true, local:true` as long as `repositoryUrl` parses
// as an http(s) URL (a bare path or `file://` is rejected).
//
// Run as a standalone Node process (invoked via child_process from the
// Playwright spec, not imported into it) so the native SDK's process
// lifecycle (`lore.shutdown()`) never touches the test runner's own process.
import { lore } from '@lore-vcs/sdk';

const [, , repositoryPath, repositoryUrl] = process.argv;
if (!repositoryPath) {
  console.error('usage: node bootstrap-offline-repo.mjs <repositoryPath> [repositoryUrl]');
  process.exit(1);
}

await lore
  .repositoryCreate(
    { repositoryPath, offline: true, local: true },
    { repositoryUrl: repositoryUrl ?? 'https://lore.example.com/e2e-fixture', id: '' }
  )
  .waitAsync();

lore.shutdown();
