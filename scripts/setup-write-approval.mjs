import { generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const argument = process.argv[2];
if (!argument || !argument.startsWith('--directory=') || process.argv.length !== 3) throw new Error('Usage: node scripts/setup-write-approval.mjs --directory=PATH');
const directory = resolve(argument.slice('--directory='.length));
await mkdir(directory, { recursive: true, mode: 0o700 });
const info = await lstat(directory);
if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('Use a private directory.');
const keys = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
await writeFile(join(directory, 'private.pem'), keys.privateKey, { mode: 0o600, flag: 'wx' });
await writeFile(join(directory, 'public.pem'), keys.publicKey, { mode: 0o600, flag: 'wx' });
process.stdout.write('Created local operator signing key pair. Only public.pem belongs in MCP configuration. No Flexi request was sent.\n');
