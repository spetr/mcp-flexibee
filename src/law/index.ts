import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  LAW_REGIMES, LAW_TOPICS, OFFICIAL_HOSTS, SOURCE_KINDS, officialSourceRegistry,
} from './registry.ts';
import type { LawRegime, LawTopic, OfficialSource, SourceKind } from './registry.ts';

export { LAW_REGIMES, LAW_TOPICS, OFFICIAL_HOSTS, SOURCE_KINDS, officialSourceRegistry };
export type { LawRegime, LawTopic, OfficialSource, SourceKind };

export class LawValidationError extends Error {
  readonly code = 'LAW_VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'LawValidationError';
  }
}

export interface EffectiveInterval { effectiveFrom: string; effectiveTo: string | null }
export interface CorpusFragment extends EffectiveInterval {
  id: string;
  provision: string;
  regimes: LawRegime[];
  topics: LawTopic[];
  text: string;
  sha256: string;
}
export interface CorpusDocument {
  id: string;
  title: string;
  sourceKind: SourceKind;
  officialUrl: string;
  retrievedAt: string;
  verifiedAt: string;
  snapshot: { path: string; sha256: string };
  fragments: CorpusFragment[];
}
export interface CorpusCoverage extends EffectiveInterval {
  regime: LawRegime;
  topic: LawTopic;
  status: 'complete';
}
export interface CorpusManifest {
  schemaVersion: 1;
  releaseId: string;
  classification: 'public_legislation';
  publishedAt: string;
  approval: { status: 'approved'; reviewedBy: string; reviewedAt: string };
  coverage: CorpusCoverage[];
  documents: CorpusDocument[];
}
export interface LawServiceOptions {
  corpusPath?: string;
  expectedManifestSha256?: string;
  maxAgeDays?: number;
  now?: () => Date;
}
export interface LawSearchInput {
  asOf: string;
  regime: LawRegime;
  topics: readonly LawTopic[];
  limit?: number;
}
export interface LawProvisionInput { id: string; asOf: string }
export interface LawRelease {
  id: string;
  manifestSha256: string;
  publishedAt: string;
  reviewedBy: string;
  reviewedAt: string;
}
export interface LawFreshness {
  checkedAt: string;
  maxAgeDays: number;
  staleDocumentIds: string[];
  oldestRetrievedAt: string | null;
  oldestVerifiedAt: string | null;
}
export interface LawCitation extends CorpusFragment {
  documentId: string;
  documentTitle: string;
  sourceKind: SourceKind;
  officialUrl: string;
  retrievedAt: string;
  verifiedAt: string;
  snapshotSha256: string;
  releaseId: string;
  manifestSha256: string;
}
export interface LawStatus {
  status: 'ready' | 'not_ready';
  reasons: string[];
  release: LawRelease | null;
  freshness: LawFreshness;
  officialSources: OfficialSource[];
  coverage: CorpusCoverage[];
  documentCount: number;
  fragmentCount: number;
}
export interface LawResult extends LawStatus {
  asOf: string;
  fragments: LawCitation[];
  totalMatches: number;
  truncated: boolean;
}

const DAY_MS = 86_400_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;
const PRAGUE_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit',
});

function fail(message: string): never { throw new LawValidationError(message); }
function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) fail(`${label} contains unknown fields`);
  return result;
}
function string(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    fail(`${label} must be a nonempty string of at most ${max} characters`);
  }
  return value;
}
function identifier(value: unknown, label: string): string {
  const result = string(value, label, 128);
  if (!ID_PATTERN.test(result)) fail(`${label} is not a valid identifier`);
  return result;
}
function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}
function member<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(`${label} is not allowlisted`);
  return value as T;
}
function list(value: unknown, label: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${label} has an invalid length`);
  return value;
}
function members<T extends string>(value: unknown, allowed: readonly T[], label: string): T[] {
  const result = list(value, label, 1, allowed.length).map(item => member(item, allowed, label));
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates`);
  return result;
}
export function validateAsOf(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') {
    fail('asOf must be a civil date in YYYY-MM-DD format');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('asOf must be a valid civil date');
  }
  return value;
}
function timestamp(value: unknown, label: string, nowMs: number): string {
  const result = string(value, label, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)) fail(`${label} must be canonical UTC ISO timestamp`);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== result || parsed.valueOf() > nowMs) {
    fail(`${label} must be valid and must not be in the future`);
  }
  validateAsOf(result.slice(0, 10));
  return result;
}
function interval(value: Record<string, unknown>, label: string): EffectiveInterval {
  const effectiveFrom = validateAsOf(value.effectiveFrom);
  const effectiveTo = value.effectiveTo === null ? null : validateAsOf(value.effectiveTo);
  if (effectiveTo !== null && effectiveTo <= effectiveFrom) fail(`${label} effectiveTo must be after effectiveFrom`);
  return { effectiveFrom, effectiveTo };
}
function officialUrl(value: unknown): string {
  const result = string(value, 'officialUrl', 2048);
  let parsed: URL;
  try { parsed = new URL(result); } catch { return fail('officialUrl must be a valid URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
      !(OFFICIAL_HOSTS as readonly string[]).includes(parsed.hostname)) {
    fail('officialUrl must use HTTPS on an exact approved primary source host');
  }
  return result;
}
function contains(interval: EffectiveInterval, date: string): boolean {
  return interval.effectiveFrom <= date && (interval.effectiveTo === null || date < interval.effectiveTo);
}
function overlaps(a: EffectiveInterval, b: EffectiveInterval): boolean {
  return (b.effectiveTo === null || a.effectiveFrom < b.effectiveTo) &&
    (a.effectiveTo === null || b.effectiveFrom < a.effectiveTo);
}
function digest(content: string | Uint8Array): string { return createHash('sha256').update(content).digest('hex'); }
function nowValue(now: () => Date): Date {
  const result = now();
  if (!(result instanceof Date) || !Number.isFinite(result.valueOf())) fail('now() returned an invalid Date');
  return result;
}
function pragueDate(at: Date): string {
  const parts = PRAGUE_DATE_FORMAT.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === type)!.value;
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function parseManifest(value: unknown, nowMs: number): CorpusManifest {
  const root = record(value, ['schemaVersion', 'releaseId', 'classification', 'publishedAt', 'approval', 'coverage', 'documents'], 'manifest');
  if (root.schemaVersion !== 1) fail('Unsupported corpus schemaVersion');
  if (root.classification !== 'public_legislation') fail('Only public_legislation corpora are permitted');
  const approval = record(root.approval, ['status', 'reviewedBy', 'reviewedAt'], 'approval');
  if (approval.status !== 'approved') fail('Corpus must have approved review status');
  const reviewedAt = timestamp(approval.reviewedAt, 'approval.reviewedAt', nowMs);
  const publishedAt = timestamp(root.publishedAt, 'publishedAt', nowMs);
  if (reviewedAt > publishedAt) fail('Release must be published after its review');
  const coverage = list(root.coverage, 'coverage', 0, 2000).map((item): CorpusCoverage => {
    const row = record(item, ['regime', 'topic', 'status', 'effectiveFrom', 'effectiveTo'], 'coverage row');
    if (row.status !== 'complete') fail('Coverage must be explicitly reviewed as complete');
    return { regime: member(row.regime, LAW_REGIMES, 'coverage regime'), topic: member(row.topic, LAW_TOPICS, 'coverage topic'), status: 'complete', ...interval(row, 'coverage') };
  });
  const documents = list(root.documents, 'documents', 0, 200).map((item): CorpusDocument => {
    const doc = record(item, ['id', 'title', 'sourceKind', 'officialUrl', 'retrievedAt', 'verifiedAt', 'snapshot', 'fragments'], 'document');
    const retrievedAt = timestamp(doc.retrievedAt, 'retrievedAt', nowMs);
    const verifiedAt = timestamp(doc.verifiedAt, 'verifiedAt', nowMs);
    if (retrievedAt > verifiedAt || verifiedAt > reviewedAt) fail('Expected retrievedAt <= verifiedAt <= reviewedAt');
    const snapshot = record(doc.snapshot, ['path', 'sha256'], 'snapshot');
    const snapshotPath = string(snapshot.path, 'snapshot.path', 1024);
    if (isAbsolute(snapshotPath) || snapshotPath.split(/[\\/]/).some(part => part === '..') || snapshotPath.includes('\\')) {
      fail('snapshot.path must be a relative path contained in the corpus directory');
    }
    const fragments = list(doc.fragments, 'fragments', 1, 2000).map((item): CorpusFragment => {
      const frag = record(item, ['id', 'provision', 'regimes', 'topics', 'text', 'sha256', 'effectiveFrom', 'effectiveTo'], 'fragment');
      const text = string(frag.text, 'fragment.text', 100_000);
      const contentHash = sha(frag.sha256, 'fragment.sha256');
      if (digest(text) !== contentHash) fail('Fragment SHA-256 mismatch');
      return {
        id: identifier(frag.id, 'fragment.id'), provision: string(frag.provision, 'provision'),
        regimes: members(frag.regimes, LAW_REGIMES, 'fragment regimes'),
        topics: members(frag.topics, LAW_TOPICS, 'fragment topics'),
        text, sha256: contentHash, ...interval(frag, 'fragment'),
      };
    });
    return {
      id: identifier(doc.id, 'document.id'), title: string(doc.title, 'document.title'),
      sourceKind: member(doc.sourceKind, SOURCE_KINDS, 'sourceKind'), officialUrl: officialUrl(doc.officialUrl),
      retrievedAt, verifiedAt, snapshot: { path: snapshotPath, sha256: sha(snapshot.sha256, 'snapshot.sha256') }, fragments,
    };
  });
  if (new Set(documents.map(doc => doc.id)).size !== documents.length) fail('Document IDs must be unique');
  const fragments = documents.flatMap(doc => doc.fragments);
  if (fragments.length > 5000) fail('Corpus has too many fragments');
  for (let i = 0; i < fragments.length; i++) {
    for (let j = i + 1; j < fragments.length; j++) {
      const a = fragments[i]!;
      const b = fragments[j]!;
      if (a.id === b.id && overlaps(a, b)) fail(`Overlapping versions of provision ${a.id}`);
    }
  }
  for (let i = 0; i < coverage.length; i++) {
    const row = coverage[i]!;
    for (const other of coverage.slice(i + 1)) {
      if (row.regime === other.regime && row.topic === other.topic && overlaps(row, other)) fail('Overlapping coverage intervals');
    }
    // Structural support is necessary, but human review is still responsible
    // for whether every relevant provision has actually been captured.
    const supporting = fragments.filter(frag => frag.regimes.includes(row.regime) && frag.topics.includes(row.topic))
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    let through: string | null = row.effectiveFrom;
    for (const frag of supporting) {
      if (through === null || frag.effectiveFrom > through) break;
      if (frag.effectiveTo === null || frag.effectiveTo > through) through = frag.effectiveTo;
    }
    if (through !== null && (row.effectiveTo === null || through < row.effectiveTo)) fail('Coverage is not supported by fragment intervals');
  }
  return {
    schemaVersion: 1, releaseId: identifier(root.releaseId, 'releaseId'), classification: 'public_legislation',
    publishedAt, approval: { status: 'approved', reviewedBy: string(approval.reviewedBy, 'reviewedBy'), reviewedAt },
    coverage, documents,
  };
}

/** A reviewed, memory-resident release. This class performs no network access. */
export class LawService {
  private readonly corpus: CorpusManifest | null;
  private readonly manifestSha256: string | null;
  private readonly maxAgeDays: number;
  private readonly now: () => Date;

  private constructor(corpus: CorpusManifest | null, manifestSha256: string | null, maxAgeDays: number, now: () => Date) {
    this.corpus = deepFreeze(corpus);
    this.manifestSha256 = manifestSha256;
    this.maxAgeDays = maxAgeDays;
    this.now = now;
  }

  static async create(options: LawServiceOptions = {}): Promise<LawService> {
    const maxAgeDays = options.maxAgeDays ?? 30;
    if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0 || maxAgeDays > 365) fail('maxAgeDays must be greater than 0 and at most 365');
    const now = options.now ?? (() => new Date());
    const time = nowValue(now);
    if (options.corpusPath === undefined) {
      if (options.expectedManifestSha256 !== undefined) fail('Manifest pin requires corpusPath');
      return new LawService(null, null, maxAgeDays, now);
    }
    string(options.corpusPath, 'corpusPath', 4096);
    try {
      const configured = resolve(options.corpusPath);
      const manifestPath = (await stat(configured)).isDirectory() ? resolve(configured, 'manifest.json') : configured;
      const canonicalManifest = await realpath(manifestPath);
      const corpusRoot = dirname(canonicalManifest);
      const manifestStat = await stat(canonicalManifest);
      if (!manifestStat.isFile()) fail('Manifest must be a regular file');
      if (manifestStat.size > MAX_MANIFEST_BYTES) fail('Manifest exceeds size limit');
      const bytes = await readFile(canonicalManifest);
      if (bytes.byteLength > MAX_MANIFEST_BYTES) fail('Manifest exceeds size limit');
      const manifestHash = digest(bytes);
      if (options.expectedManifestSha256 !== undefined && sha(options.expectedManifestSha256, 'expectedManifestSha256') !== manifestHash) {
        fail('Manifest SHA-256 pin mismatch');
      }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
      catch { return fail('Manifest must be valid UTF-8 JSON'); }
      const corpus = parseManifest(parsed, time.valueOf());
      let totalBytes = 0;
      for (const doc of corpus.documents) {
        const path = await realpath(resolve(corpusRoot, doc.snapshot.path));
        const fromRoot = relative(corpusRoot, path);
        if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) fail('Snapshot resolves outside corpus directory');
        const snapshotStat = await stat(path);
        if (!snapshotStat.isFile()) fail('Snapshots must be regular files');
        const size = snapshotStat.size;
        totalBytes += size;
        if (size > MAX_SNAPSHOT_BYTES || totalBytes > MAX_TOTAL_SNAPSHOT_BYTES) fail('Snapshots exceed size limit');
        const snapshot = await readFile(path);
        if (snapshot.byteLength > MAX_SNAPSHOT_BYTES || snapshot.byteLength !== size) fail('Snapshot changed during import or exceeds size limit');
        if (digest(snapshot) !== doc.snapshot.sha256) fail(`Snapshot SHA-256 mismatch for ${doc.id}`);
        let fullText: string;
        try { fullText = new TextDecoder('utf-8', { fatal: true }).decode(snapshot); }
        catch { return fail('Snapshots must contain UTF-8 full text'); }
        for (const fragment of doc.fragments) {
          if (!fullText.includes(fragment.text)) fail(`Fragment ${fragment.id} is not verbatim in its full-text snapshot`);
        }
      }
      return new LawService(corpus, manifestHash, maxAgeDays, now);
    } catch (error) {
      if (error instanceof LawValidationError) throw error;
      // Do not leak configured filesystem paths through a remotely exposed tool.
      throw new LawValidationError('Configured corpus could not be read');
    }
  }

  private describe(asOf: string, pairs: readonly { regime: LawRegime; topic: LawTopic }[], at: Date): LawStatus {
    const corpus = this.corpus;
    const docs = corpus?.documents ?? [];
    const staleDocumentIds = docs.filter(doc =>
      at.valueOf() - Date.parse(doc.retrievedAt) > this.maxAgeDays * DAY_MS ||
      at.valueOf() - Date.parse(doc.verifiedAt) > this.maxAgeDays * DAY_MS ||
      Date.parse(doc.verifiedAt) > at.valueOf(),
    ).map(doc => doc.id);
    const reasons: string[] = [];
    if (asOf > pragueDate(at)) reasons.push('future_as_of_not_supported');
    if (!corpus || docs.length === 0) reasons.push('No approved normative corpus is loaded; official links are discovery metadata only.');
    if (staleDocumentIds.length) reasons.push('Corpus contains stale source retrieval or verification timestamps; reviewed refresh required.');
    for (const pair of pairs) {
      if (!corpus?.coverage.some(row => row.regime === pair.regime && row.topic === pair.topic && contains(row, asOf))) {
        reasons.push(`No reviewed complete coverage for ${pair.regime}/${pair.topic} on ${asOf}.`);
      }
    }
    return {
      status: reasons.length === 0 ? 'ready' : 'not_ready', reasons,
      release: corpus ? {
        id: corpus.releaseId, manifestSha256: this.manifestSha256!, publishedAt: corpus.publishedAt,
        reviewedBy: corpus.approval.reviewedBy, reviewedAt: corpus.approval.reviewedAt,
      } : null,
      freshness: {
        checkedAt: at.toISOString(), maxAgeDays: this.maxAgeDays, staleDocumentIds,
        oldestRetrievedAt: docs.map(doc => doc.retrievedAt).sort()[0] ?? null,
        oldestVerifiedAt: docs.map(doc => doc.verifiedAt).sort()[0] ?? null,
      },
      officialSources: officialSourceRegistry(), coverage: structuredClone(corpus?.coverage ?? []),
      documentCount: docs.length, fragmentCount: docs.reduce((sum, doc) => sum + doc.fragments.length, 0),
    };
  }

  status(): LawStatus {
    const at = nowValue(this.now);
    const pairs = LAW_REGIMES.flatMap(regime => LAW_TOPICS.map(topic => ({ regime, topic })));
    return this.describe(pragueDate(at), pairs, at);
  }

  private citations(asOf: string): LawCitation[] {
    return (this.corpus?.documents ?? []).flatMap(doc => doc.fragments.filter(frag => contains(frag, asOf)).map(frag => ({
      ...structuredClone(frag), documentId: doc.id, documentTitle: doc.title,
      sourceKind: doc.sourceKind, officialUrl: doc.officialUrl, retrievedAt: doc.retrievedAt,
      verifiedAt: doc.verifiedAt, snapshotSha256: doc.snapshot.sha256,
      releaseId: this.corpus!.releaseId, manifestSha256: this.manifestSha256!,
    })));
  }

  search(input: LawSearchInput): LawResult {
    const request = record(input, ['asOf', 'regime', 'topics', 'limit'], 'search input');
    const asOf = validateAsOf(request.asOf);
    const regime = member(request.regime, LAW_REGIMES, 'regime');
    const topics = members(request.topics, LAW_TOPICS, 'topics');
    const limit = request.limit ?? 20;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) fail('limit must be an integer from 1 to 50');
    const status = this.describe(asOf, topics.map(topic => ({ regime, topic })), nowValue(this.now));
    const matches = status.status === 'ready' ? this.citations(asOf)
      .filter(frag => frag.regimes.includes(regime) && topics.some(topic => frag.topics.includes(topic)))
      .sort((a, b) => a.id.localeCompare(b.id)) : [];
    return { ...status, asOf, fragments: matches.slice(0, limit), totalMatches: matches.length, truncated: matches.length > limit };
  }

  getProvision(input: LawProvisionInput): LawResult {
    const request = record(input, ['id', 'asOf'], 'provision input');
    const asOf = validateAsOf(request.asOf);
    const id = identifier(request.id, 'id');
    const matches = this.citations(asOf).filter(frag => frag.id === id);
    const pairs = matches.flatMap(frag => frag.regimes.flatMap(regime => frag.topics.map(topic => ({ regime, topic }))));
    const status = this.describe(asOf, pairs, nowValue(this.now));
    if (matches.length === 0) {
      status.status = 'not_ready';
      status.reasons.push('No reviewed provision with this identifier is effective on the requested date.');
    }
    return { ...status, asOf, fragments: status.status === 'ready' ? matches : [], totalMatches: status.status === 'ready' ? matches.length : 0, truncated: false };
  }
}
