import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { IntentStore, signApproval } from '../src/write-store.ts';

/** Operator-only approval. Never invoked by an MCP tool or an automated agent. */
async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write('Run manually in a terminal: node scripts/approve-write.ts --store=PATH --key=PRIVATE_KEY --intent=UUID --digest=SHA256\nReview the displayed diff, then type SCHVALUJI followed by the exact digest. This does not commit to Flexi.\n');
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Approval requires an operator terminal.');
  const args = new Map<string, string>();
  for (const argument of process.argv.slice(2)) {
    const match = /^--(store|key|intent|digest)=(.+)$/.exec(argument);
    if (!match || args.has(match[1]!)) throw new Error('Invalid arguments.');
    args.set(match[1]!, match[2]!);
  }
  if (args.size !== 4 || !/^[a-f0-9]{64}$/.test(args.get('digest')!)) throw new Error('All four arguments are required.');
  const store = new IntentStore(resolve(args.get('store')!));
  const intent = await store.get(args.get('intent')!);
  const state = await store.readState(intent.id);
  if (intent.digest !== args.get('digest') || state.status !== 'prepared' || Date.parse(intent.expiresAt) <= Date.now()) throw new Error('Intent changed, expired, or already consumed.');
  process.stdout.write(JSON.stringify({ target: intent.target, database: intent.database, invoiceId: intent.invoiceId, invoiceCode: intent.expectedCode, digest: intent.digest, expiresAt: intent.expiresAt, headerPatch: intent.headerPatch, items: intent.items, previousInvoice: intent.snapshot.invoice, previousItems: intent.snapshot.items, calculatedDryRun: intent.dryRun, accountingExpectation: intent.accountingExpectation ?? null }, null, 2) + '\n');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try { answer = await terminal.question(`Pro schválení napište SCHVALUJI ${intent.digest}\n> `); }
  finally { terminal.close(); }
  if (answer !== `SCHVALUJI ${intent.digest}`) throw new Error('Approval was not granted.');
  if (Date.parse(intent.expiresAt) <= Date.now()) throw new Error('Intent expired during review.');
  const keyFile = await open(resolve(args.get('key')!), constants.O_RDONLY | constants.O_NOFOLLOW);
  let key: Buffer | undefined;
  try {
    const info = await keyFile.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 16_384 || (info.mode & 0o077) !== 0) throw new Error('Unsafe operator key permissions.');
    key = await keyFile.readFile();
    await store.putApproval(intent.id, signApproval(intent, key));
  } finally { key?.fill(0); await keyFile.close(); }
  process.stdout.write(`Signed exact intent ${intent.id}. No request was sent to Flexi.\n`);
}
main().catch(() => { process.stderr.write('Approval failed or cancelled. No approval or commit was performed; inspect the intent and local permissions.\n'); process.exitCode = 1; });
