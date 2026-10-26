import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Hosts may start us in any directory and open several conversations at once.
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
try {
  process.loadEnvFile(join(root, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
// A separate audit chain per process avoids conflicting exclusive audit locks.
process.env.MCP_AUDIT_PATH = join(root, '.state', 'chatgpt', `audit-${randomUUID()}.jsonl`);
await import('../dist/index.js');
