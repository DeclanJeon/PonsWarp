#!/usr/bin/env node
/** LAN evidence harness: deterministic, authenticated, fail-closed. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  createHmac,
  createHash,
  timingSafeEqual,
  randomUUID,
} from 'node:crypto';
import { createConnection, createServer as createTcpServer } from 'node:net';
import { createReadStream } from 'node:fs';
import {
  readFile,
  writeFile,
  rename,
  stat,
  lstat,
  realpath,
  mkdtemp,
  rm,
  appendFile,
  mkdir,
  readdir,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, relative, sep, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import tar from 'tar-stream';
const execFileAsync = promisify(execFile);

export const DEFAULTS = Object.freeze({
  senderPort: 4173,
  receiverPort: 4174,
  pairs: 20,
  browsers: ['chrome', 'edge'],
});
export const ARCHIVE_MTIME = new Date(0);
const HEX64 = /^[a-f0-9]{64}$/;
const MODES = new Set([
  'archive-arm',
  'controller',
  'receiver',
  'gate',
  'analyze',
]);
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function validateCohort(value) {
  if (value !== 'on' && value !== 'off')
    throw new Error('cohort must be on or off');
  return value;
}
export function validateProfile(value) {
  if (!['lan256', 'lan1g'].includes(value))
    throw new Error('profile must be lan256 or lan1g');
  return value;
}
export function normalizeSignalingUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error('invalid signaling URL');
  }
  if (
    u.protocol !== 'ws:' ||
    u.port !== '5502' ||
    u.pathname !== '/ws' ||
    u.search ||
    u.hash ||
    u.username ||
    u.password ||
    u.hostname === 'localhost' ||
    u.hostname === '127.0.0.1' ||
    u.hostname === '::1'
  )
    throw new Error('signaling URL must be ws://non-loopback-lan:5502/ws');
  if (!u.hostname || u.hostname === '0.0.0.0' || u.hostname === '::')
    throw new Error('signaling URL must be non-loopback');
  return `ws://${u.hostname.toLowerCase()}:5502/ws`;
}
export function parseArgs(argv) {
  const out = { _: [] },
    known = new Set([
      'input',
      'output',
      'out',
      'certificate',
      'cohort',
      'profile',
      'archive-sha256',
      'tree-digest',
      'manifest-digest',
      'arm-digest',
      'run-id',
      'secret',
      'signaling-url',
      'browser',
      'browser-executable',
      'host-pair',
      'pipeline-on',
      'listen',
      'connect',
      'sender-static-port',
      'receiver-static-port',
      'arm',
      'control',
      'archive',
      'artifact-dir',
      'require-paired-interleaved',
      'dir',
      'source-epoch',
      'serial-run',
      'pipeline-arm',
    ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split('=', 2);
    if (!known.has(k)) throw new Error(`unknown option --${k}`);
    const v = inline ?? argv[++i];
    if (v === undefined || v.startsWith('--'))
      throw new Error(`missing value for --${k}`);
    out[k] = v;
  }
  return out;
}
function safePath(name) {
  const n = String(name).normalize('NFC');
  if (
    !n ||
    n.startsWith('/') ||
    n.includes('\\') ||
    n.split('/').some(x => x === '..' || x === '') ||
    Buffer.byteLength(n) > 255 ||
    n.split('/').some(x => Buffer.byteLength(x) > 100)
  )
    throw new Error(`unsafe archive path: ${name}`);
  return n;
}
export function treeDigest(entries) {
  const sorted = [...entries].sort((a, b) =>
    a.name.localeCompare(b.name, 'und')
  );
  const h = createHash('sha256');
  for (const e of sorted) {
    const p = Buffer.from(safePath(e.name));
    const d = Buffer.from(e.data);
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(d.length));
    h.update(p).update(Buffer.of(0)).update(len).update(Buffer.of(0)).update(d);
  }
  return h.digest('hex');
}
export async function archiveEntries(entries, { sourceDateEpoch = 0 } = {}) {
  const seen = new Set();
  const normalized = [];
  for (const e of entries) {
    const name = safePath(e.name);
    if (e.type && e.type !== 'file')
      throw new Error('unsupported archive entry type');
    if (seen.has(name)) throw new Error('duplicate or NFC-collision path');
    seen.add(name);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    if (data.length > 1024 * 1024 * 1024) throw new Error('file exceeds 1 GiB');
    normalized.push({ name, data });
  }
  normalized.sort((a, b) => a.name.localeCompare(b.name, 'und'));
  const pack = tar.pack(),
    chunks = [];
  pack.on('data', c => chunks.push(c));
  for (const e of normalized)
    pack.entry(
      {
        name: e.name,
        mode: 0o644,
        uid: 0,
        gid: 0,
        uname: '',
        gname: '',
        size: e.data.length,
        mtime: new Date(sourceDateEpoch * 1000),
      },
      e.data
    );
  pack.finalize();
  const archive = await new Promise((res, rej) => {
    pack.on('end', () => res(Buffer.concat(chunks)));
    pack.on('error', rej);
  });
  if (archive.length > 2 * 1024 * 1024 * 1024)
    throw new Error('archive exceeds 2 GiB');
  return archive;
}
export async function extractEntries(data) {
  const ex = tar.extract(),
    out = [],
    names = new Set();
  const done = new Promise((res, rej) => {
    ex.on('finish', res);
    ex.on('error', rej);
  });
  ex.on('entry', (h, s, next) => {
    try {
      const n = safePath(h.name);
      if (names.has(n) || h.type !== 'file' || h.size > 1024 * 1024 * 1024)
        throw new Error('invalid archive entry');
      names.add(n);
      const c = [];
      s.on('data', x => c.push(x));
      s.on('end', () => {
        out.push({ name: n, data: Buffer.concat(c) });
        next();
      });
      s.resume();
    } catch (e) {
      s.resume();
      ex.destroy(e);
    }
  });
  ex.end(data);
  await done;
  return Object.fromEntries(out.map(e => [e.name, e.data]));
}
export async function archiveAndDigest(entries, options = {}) {
  const archive = await archiveEntries(entries, options),
    extracted = await extractEntries(archive),
    list = Object.entries(extracted).map(([name, data]) => ({ name, data }));
  const digest = Object.fromEntries(
    list
      .sort((a, b) => a.name.localeCompare(b.name, 'und'))
      .map(e => [e.name, sha256(e.data)])
  );
  const tree = treeDigest(list),
    manifestDigest = sha256(
      canonical({
        sourceDateEpoch: options.sourceDateEpoch ?? 0,
        treeDigest: tree,
        files: digest,
      })
    );
  const armDigest = sha256(
    Buffer.concat([
      Buffer.from('ponswarp-evidence-arm-v1\n'),
      Buffer.from(tree, 'hex'),
      Buffer.from(manifestDigest, 'hex'),
    ])
  );
  return {
    archive,
    archiveSha256: sha256(archive),
    treeDigest: tree,
    manifestDigest,
    armDigest,
    digest,
  };
}
export function armManifest({
  arm,
  sourceDateEpoch,
  normalizedSignalingUrl,
  flags,
  gitSha,
  exclusions = [
    'evidence-arm.json',
    'server.log',
    'server-*.log',
    'run-artifacts/**',
  ],
  treeDigest,
}) {
  if (!['serial-metrics', 'pipeline-on'].includes(arm))
    throw new Error('arm must be serial-metrics or pipeline-on');
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0)
    throw new Error('invalid source epoch');
  if (
    flags &&
    (flags.pipeline !== (arm === 'pipeline-on') ||
      flags.metrics !== true ||
      flags.bridge !== true ||
      flags.evidenceFsa !== true)
  )
    throw new Error('invalid arm public flags');
  return {
    version: 1,
    kind: 'evidence-arm',
    arm,
    sourceDateEpoch,
    normalizedSignalingUrl: normalizeSignalingUrl(normalizedSignalingUrl),
    flags: {
      metrics: flags?.metrics === true,
      pipeline: flags?.pipeline === true,
      bridge: flags?.bridge === true,
      evidenceFsa: flags?.evidenceFsa === true,
    },
    gitSha: String(gitSha || ''),
    exclusions,
    treeDigest,
  };
}
function excludedArmPath(name) {
  return (
    name === 'evidence-arm.json' ||
    name === 'server.log' ||
    /^server-[^/]+\.log$/.test(name) ||
    name.startsWith('run-artifacts/')
  );
}
async function collectArmFiles(root) {
  const entries = [],
    normalized = new Set();
  async function walk(dir) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      const raw = relative(root, full).split(sep).join('/');
      const name = safePath(raw);
      if (excludedArmPath(name)) continue;
      const st = await lstat(full);
      if (st.isSymbolicLink()) throw new Error(`unsupported arm entry: ${raw}`);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!st.isFile()) throw new Error(`unsupported arm entry: ${raw}`);
      if (st.size > 1024 * 1024 * 1024) throw new Error('file exceeds 1 GiB');
      const n = name.normalize('NFC');
      if (normalized.has(n)) throw new Error('duplicate or NFC-collision path');
      normalized.add(n);
      entries.push({ name, data: await readFile(full) });
    }
  }
  await walk(root);
  return entries;
}
async function resolveGitSha(root) {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      root,
      'rev-parse',
      'HEAD',
    ]);
    return stdout.trim();
  } catch {
    throw new Error('unable to determine git SHA');
  }
}
export async function archiveArm({
  dir,
  arm,
  sourceEpoch,
  sourceDateEpoch = sourceEpoch,
  signalingUrl,
  flags,
  out,
  git,
  gitSha,
} = {}) {
  if (!dir || !signalingUrl || !out)
    throw new Error('archive-arm requires --dir, --signaling-url and --out');
  const root = resolve(dir),
    epoch = Number(sourceDateEpoch);
  if (!(await stat(root)).isDirectory())
    throw new Error('arm directory required');
  const entries = await collectArmFiles(root),
    tree = treeDigest(entries);
  const manifest = armManifest({
    arm,
    sourceDateEpoch: epoch,
    normalizedSignalingUrl: signalingUrl,
    flags: flags || {
      metrics: true,
      pipeline: arm === 'pipeline-on',
      bridge: true,
      evidenceFsa: true,
    },
    gitSha: git || gitSha || (await resolveGitSha(root)),
    treeDigest: tree,
  });
  const manifestDigest = sha256(Buffer.from(canonical(manifest)));
  const armDigest = sha256(
    Buffer.concat([
      Buffer.from('ponswarp-evidence-arm-v1\n'),
      Buffer.from(tree, 'hex'),
      Buffer.from(manifestDigest, 'hex'),
    ])
  );
  const archive = await archiveEntries(entries, { sourceDateEpoch: epoch });
  const result = {
    ...manifest,
    archive,
    archiveSha256: sha256(archive),
    manifestDigest,
    armDigest,
  };
  await atomicWrite(resolve(out), archive);
  await atomicWrite(
    `${resolve(out)}.manifest.json`,
    JSON.stringify({ ...result, archive: undefined }, null, 2)
  );
  return result;
}
function armIdentity(m) {
  return [
    m.archiveSha256,
    m.treeDigest,
    m.manifestDigest,
    m.armDigest,
    m.sourceDateEpoch,
    m.normalizedSignalingUrl,
  ].join('|');
}
export async function verifyArmArchive(
  archivePath,
  manifestOrExpected = {},
  expected = {}
) {
  const manifestPath =
    typeof manifestOrExpected === 'string'
      ? manifestOrExpected
      : `${archivePath}.manifest.json`;
  const supplied =
    typeof manifestOrExpected === 'string'
      ? JSON.parse(await readFile(manifestPath, 'utf8'))
      : Object.keys(manifestOrExpected).length
        ? manifestOrExpected
        : JSON.parse(await readFile(manifestPath, 'utf8'));
  const bytes = await readFile(archivePath);
  const entries = Object.entries(await extractEntries(bytes)).map(
    ([name, data]) => ({ name, data })
  );
  const tree = treeDigest(entries);
  const manifest = armManifest({ ...supplied, treeDigest: tree });
  const md = sha256(Buffer.from(canonical(manifest)));
  const ad = sha256(
    Buffer.concat([
      Buffer.from('ponswarp-evidence-arm-v1\n'),
      Buffer.from(tree, 'hex'),
      Buffer.from(md, 'hex'),
    ])
  );
  if (
    sha256(bytes) !== supplied.archiveSha256 ||
    tree !== supplied.treeDigest ||
    md !== supplied.manifestDigest ||
    ad !== supplied.armDigest
  )
    throw new Error('arm archive verification failed');
  for (const [k, v] of Object.entries(expected))
    if (
      k === 'distinctFrom'
        ? armIdentity(supplied) === armIdentity(v)
        : supplied[k] !== v
    )
      throw new Error('arm identity mismatch');
  return {
    ...supplied,
    archiveSha256: sha256(bytes),
    treeDigest: tree,
    manifestDigest: md,
    armDigest: ad,
  };
}
export async function materializeArmArchive(archivePath, expected = {}) {
  const manifest = await verifyArmArchive(archivePath, {}, expected);
  const bytes = await readFile(archivePath);
  const entries = await extractEntries(bytes);
  const root = await mkdtemp(join(tmpdir(), 'ponswarp-arm-'));
  try {
    for (const [name, data] of Object.entries(entries)) {
      const safeName = safePath(name);
      const destination = resolve(root, safeName);
      if (!destination.startsWith(`${root}${sep}`))
        throw new Error('arm extraction escaped destination');
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, data, { mode: 0o400 });
      await chmod(destination, 0o400);
    }
    return {
      root,
      manifest,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
function b64(data) {
  return Buffer.from(data).toString('base64url');
}
export function makeGateCertificate(input) {
  const { key, ...body } = input;
  if (!key) throw new Error('certificate key required');
  if (body.version === undefined) body.version = 1;
  body.version = 1;
  if (
    !body.runId ||
    !body.certificateId ||
    !body.issuedAtMs ||
    !body.expiresAtMs ||
    body.expiresAtMs !== body.issuedAtMs + 30 * 60 * 1000
  )
    throw new Error('invalid certificate lifetime');
  if (body.expiresAtMs <= Date.now()) throw new Error('certificate expired');
  const payload = canonical(body);
  return {
    ...body,
    signature: b64(createHmac('sha256', key).update(payload).digest()),
  };
}
export function verifyGateCertificate(cert, key, expected = {}) {
  try {
    if (
      !cert ||
      cert.version !== 1 ||
      !key ||
      !cert.signature ||
      cert.expiresAtMs <= Date.now() ||
      cert.expiresAtMs !== cert.issuedAtMs + 1800000
    )
      return false;
    for (const [k, v] of Object.entries(expected))
      if (JSON.stringify(cert[k]) !== JSON.stringify(v)) return false;
    const got = Buffer.from(cert.signature, 'base64url'),
      want = createHmac('sha256', key)
        .update(
          canonical(
            Object.fromEntries(
              Object.entries(cert).filter(([k]) => k !== 'signature')
            )
          )
        )
        .digest();
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
export function median(values) {
  if (!values.length) throw new Error('no samples');
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}
export function nearestRank(values, p) {
  if (!values.length || p < 0 || p > 1) throw new Error('invalid percentile');
  const v = [...values].sort((a, b) => a - b);
  return v[Math.max(0, Math.ceil(v.length * p) - 1)];
}
async function fileSha256(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}
export function analyze(
  samples,
  {
    browsers = DEFAULTS.browsers,
    pairs = 20,
    hostPair,
    requirePairedInterleaved = false,
    requireLan1gSoak = false,
  } = {}
) {
  const result = { browsers, pairs, cohorts: {}, soak: {} };
  const hex64 = /^[0-9a-f]{64}$/i;
  const stableHostUdp = tuples => {
    if (!Array.isArray(tuples) || tuples.length !== 2) return false;
    const [first, second] = tuples;
    const stableFields = [
      'selectedPairId',
      'localCandidateId',
      'remoteCandidateId',
      'localCandidateType',
      'remoteCandidateType',
      'localProtocol',
      'remoteProtocol',
      'selectedOrNominatedSucceeded',
    ];
    return (
      stableFields.every(field => first?.[field] === second?.[field]) &&
      first.localCandidateType === 'host' &&
      first.remoteCandidateType === 'host' &&
      String(first.localProtocol).toLowerCase() === 'udp' &&
      String(first.remoteProtocol).toLowerCase() === 'udp' &&
      first.selectedOrNominatedSucceeded === true &&
      Number.isFinite(first.sampledAtMs) &&
      Number.isFinite(second.sampledAtMs) &&
      second.sampledAtMs - first.sampledAtMs >= 500
    );
  };
  const validateSample = sample => {
    const required = [
      'sampleId',
      'fixtureDigest',
      'profile',
      'browserExecutableSha256',
      'hostPair',
      'signalingUrl',
      'sourceDateEpoch',
      'sourceSha256',
      'sourceReadbackSha256',
      'hostUdpTuples',
      'resumeGate',
      'lifecycle',
      'route',
      'errors',
      'mbps',
      'archiveSha256',
      'manifestDigest',
      'armDigest',
      'control',
      'bridge',
      'evidenceFsa',
      'artifactSha256',
    ];
    if (
      required.some(key => sample[key] === undefined) ||
      !Number.isFinite(Number(sample.mbps))
    )
      throw new Error('incomplete physical evidence');
    if (
      sample.sourceSha256 !== sample.sourceReadbackSha256 ||
      !stableHostUdp(sample.hostUdpTuples) ||
      sample.resumeGate !== 'pass' ||
      sample.lifecycle !== 'pass' ||
      sample.route !== 'host' ||
      sample.bridge !== true ||
      sample.evidenceFsa !== true ||
      sample.errors.length !== 0 ||
      sample.valid === false ||
      !hex64.test(sample.archiveSha256) ||
      !hex64.test(sample.manifestDigest) ||
      !hex64.test(sample.armDigest) ||
      !hex64.test(sample.artifactSha256)
    )
      throw new Error('invalid transfer evidence');
  };

  for (const browser of browsers) {
    const allRows = samples.filter(
      sample =>
        sample.browser === browser &&
        (!hostPair || sample.hostPair === hostPair)
    );
    const rows = allRows.filter(sample => sample.profile === 'lan256');
    if (rows.length !== pairs * 2)
      throw new Error(
        `expected exactly ${pairs * 2} lan256 samples for ${browser}`
      );
    const cohortIdentity = new Map();
    for (let index = 0; index < rows.length; index++) {
      const sample = rows[index];
      validateSample(sample);
      if (hostPair && sample.hostPair !== hostPair)
        throw new Error('cohort identity mismatch');
      if (sample.index !== undefined && sample.index !== Math.floor(index / 2))
        throw new Error('samples are not ordered pairs');
      const identity = [
        sample.fixtureDigest,
        sample.browserExecutableSha256,
        sample.hostPair,
        sample.signalingUrl,
        sample.sourceDateEpoch,
        sample.archiveSha256,
        sample.manifestDigest,
        sample.armDigest,
        sample.control,
      ].join('|');
      const prior = cohortIdentity.get(sample.cohort);
      if (prior && prior !== identity)
        throw new Error('immutable cohort identity mismatch');
      cohortIdentity.set(sample.cohort, identity);
    }

    const off = rows.filter(sample => sample.cohort === 'off');
    const on = rows.filter(sample => sample.cohort === 'on');
    if (off.length !== pairs || on.length !== pairs)
      throw new Error(`invalid ${browser} cohorts`);
    if (requirePairedInterleaved) {
      for (let index = 0; index < pairs; index++) {
        const offSample = rows[index * 2];
        const onSample = rows[index * 2 + 1];
        if (offSample?.cohort !== 'off' || onSample?.cohort !== 'on')
          throw new Error('samples are not paired interleaved');
        const pairedFields = [
          'fixtureDigest',
          'browserExecutableSha256',
          'hostPair',
          'signalingUrl',
          'sourceDateEpoch',
          'sourceSha256',
        ];
        if (
          pairedFields.some(field => offSample[field] !== onSample[field]) ||
          offSample.control !== 'off' ||
          onSample.control !== 'on' ||
          offSample.armDigest === onSample.armDigest ||
          offSample.archiveSha256 === onSample.archiveSha256 ||
          offSample.manifestDigest === onSample.manifestDigest
        )
          throw new Error('paired arm identity mismatch');
      }
    }
    for (const [cohort, cohortRows] of [
      ['off', off],
      ['on', on],
    ]) {
      const rates = cohortRows.map(sample => Number(sample.mbps));
      result.cohorts[`${browser}/${cohort}`] = {
        median: median(rates),
        p05: nearestRank(rates, 0.05),
      };
    }
    if (
      result.cohorts[`${browser}/on`].median < 80 ||
      result.cohorts[`${browser}/on`].p05 < 64
    )
      throw new Error(`gate failed for ${browser}/on`);

    if (requireLan1gSoak) {
      const soakRows = allRows.filter(sample => sample.profile === 'lan1g');
      if (soakRows.length !== 2)
        throw new Error(`missing lan1g soak for ${browser}`);
      const soakOff = soakRows.find(sample => sample.cohort === 'off');
      const soakOn = soakRows.find(sample => sample.cohort === 'on');
      if (!soakOff || !soakOn)
        throw new Error(`invalid lan1g soak for ${browser}`);
      for (const sample of soakRows) {
        validateSample(sample);
        if (
          sample.preparationLedgerBytes > 1_376_450 ||
          sample.queueBytes > 4 * 1024 * 1024 ||
          sample.pendingBytes > 32 * 1024 * 1024 ||
          sample.pauseCount > 3 ||
          sample.pauseDurationMs > 60_000 ||
          sample.rssDeltaBytes > 64 * 1024 * 1024 ||
          sample.finalQuarterGrowthBytes > 16 * 1024 * 1024
        )
          throw new Error(`lan1g resource gate failed for ${browser}`);
      }
      result.soak[browser] = { off: soakOff.sampleId, on: soakOn.sampleId };
    }
  }
  return result;
}
export function createEvidenceBridge({
  token,
  port = 0,
  host = '127.0.0.1',
  origins = ['http://localhost:4173', 'http://localhost:4174'],
  expiresAtMs = Date.now() + 95 * 60_000,
  artifactDir = tmpdir(),
  staticRoot,
  sharedState,
  readback = async () => Buffer.alloc(0),
} = {}) {
  if (
    !token ||
    origins.length !== 2 ||
    new Set(origins).size !== 2 ||
    origins.some(origin => {
      try {
        const parsed = new URL(origin);
        return (
          parsed.protocol !== 'http:' ||
          parsed.hostname !== 'localhost' ||
          !parsed.port ||
          parsed.pathname !== '/'
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error('invalid evidence bridge configuration');
  const state =
    sharedState ?? {
      clients: new Set(),
      commands: [],
      commandSequence: 0,
      reports: new Map(),
      reportBodies: [],
      reportListeners: new Set(),
      chunks: new Map(),
      artifacts: new Map(),
    };
  const fail = async (res, code) => {
    res.writeHead(code);
    res.end();
  };
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    if (requestUrl.pathname === '/ready' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ host, port: server.address()?.port }));
    }
    if (
      staticRoot &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      !requestUrl.pathname.startsWith('/v1/evidence/')
    ) {
      let relativePath;
      try {
        relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
      } catch {
        return fail(res, 400);
      }
      if (
        relativePath.includes('\\') ||
        relativePath.split('/').some(part => part === '..' || part.startsWith('.'))
      )
        return fail(res, 403);
      if (!relativePath) relativePath = 'index.html';
      const root = resolve(staticRoot);
      let filePath = resolve(root, relativePath);
      if (filePath !== root && !filePath.startsWith(`${root}${sep}`))
        return fail(res, 403);
      let bytes;
      try {
        bytes = await readFile(filePath);
      } catch {
        if (extname(relativePath)) return fail(res, 404);
        filePath = join(root, 'index.html');
        try {
          bytes = await readFile(filePath);
        } catch {
          return fail(res, 404);
        }
      }
      const contentTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.wasm': 'application/wasm',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
      };
      res.writeHead(200, {
        'content-type': contentTypes[extname(filePath)] || 'application/octet-stream',
        'content-length': bytes.length,
        'cache-control': 'no-store',
      });
      return req.method === 'HEAD' ? res.end() : res.end(bytes);
    }
    const origin = req.headers.origin;
    if (!origins.includes(origin)) return fail(res, 403);
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader(
      'access-control-allow-headers',
      'Authorization,Content-Type,X-Evidence-Artifact,X-Evidence-Index,X-Evidence-Offset,X-Evidence-Length,X-Evidence-Chunk-Sha256,X-Evidence-Run-Id,X-Evidence-Run-Nonce,X-Evidence-Role,X-Evidence-Seq,X-Evidence-Mac'
    );
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (
      Date.now() >= expiresAtMs ||
      req.headers.authorization !== `Bearer ${token}`
    )
      return fail(res, 401);
    if (req.url === '/v1/evidence/readback-chunk' && req.method === 'POST') {
      const h = req.headers,
        artifactId = String(h['x-evidence-artifact'] || ''),
        index = Number(h['x-evidence-index']),
        offset = Number(h['x-evidence-offset']),
        length = Number(h['x-evidence-length']),
        seq = Number(h['x-evidence-seq']),
        runId = String(h['x-evidence-run-id'] || ''),
        runNonce = String(h['x-evidence-run-nonce'] || ''),
        role = String(h['x-evidence-role'] || ''),
        chunkSha256 = String(h['x-evidence-chunk-sha256'] || ''),
        mac = String(h['x-evidence-mac'] || '');
      const metadata = {
          artifactId,
          index,
          offset,
          length,
          chunkSha256,
          runId,
          runNonce,
          role,
          seq,
        },
        expected = b64(
          createHmac('sha256', token).update(canonical(metadata)).digest()
        ),
        key = `${runId}:${runNonce}:${role}:${artifactId}`,
        previous = state.chunks.get(key);
      if (
        mac !== expected ||
        !artifactId ||
        !Number.isSafeInteger(index) ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > 131072 ||
        !Number.isSafeInteger(seq) ||
        seq !== index + 1 ||
        index !== (previous?.index ?? -1) + 1 ||
        offset !== (previous?.offset ?? 0) + (previous?.length ?? 0) ||
        req.headers['content-length'] !== String(length)
      )
        return fail(res, 400);
      const part = join(resolve(artifactDir), `${artifactId}.part`);
      await mkdir(resolve(artifactDir), { recursive: true, mode: 0o700 });
      const chunks = [];
      let total = 0;
      for await (const c of req) {
        total += c.length;
        if (total > 131072) return fail(res, 413);
        chunks.push(c);
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== length || sha256(bytes) !== chunkSha256)
        return fail(res, 400);
      await appendFile(part, bytes, { mode: 0o600 });
      state.chunks.set(key, { index, offset, length });
      state.artifacts.set(key, {
        part,
        total: (state.artifacts.get(key)?.total ?? 0) + length,
      });
      res.writeHead(204);
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    } catch {
      return fail(res, 400);
    }
    if (req.url === '/v1/evidence/hello' && req.method === 'POST') {
      res.writeHead(204);
      return res.end();
    }
    if (req.url === '/v1/evidence/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      state.clients.add(res);
      res.on('close', () => state.clients.delete(res));
      for (const c of state.commands)
        res.write(`data: ${JSON.stringify(c)}\n\n`);
      return;
    }
    if (req.url === '/v1/evidence/report' && req.method === 'POST') {
      const supplied = String(body.mac || ''),
        unsigned = { ...body };
      delete unsigned.mac;
      const expected = b64(
        createHmac('sha256', token).update(canonical(unsigned)).digest()
      );
      const key = `${body.runId}:${body.runNonce}:${body.role}`;
      const previous = state.reports.get(key) ?? 0;
      if (supplied !== expected || body.reportSeq !== previous + 1)
        return fail(res, 409);
      state.reports.set(key, body.reportSeq);
      if (body.type === 'FINALIZED') {
        const a = state.artifacts.get(`${key}:${body.payload?.artifactId}`);
        if (
          !a ||
          a.total !== body.payload.expectedSize ||
          body.payload.sourceSha256 !== (await fileSha256(a.part))
        )
          return fail(res, 400);
        await rename(a.part, a.part.replace(/\.part$/, ''));
      }
      state.reportBodies.push(body);
      for (const listener of state.reportListeners) listener(body);
      res.writeHead(204);
      return res.end();
    }
    return fail(res, 404);
  });
  return {
    server,
    state,
    listen: () =>
      new Promise((ok, failx) => {
        server.once('error', failx);
        server.listen(port, host, () => ok(server.address().port));
      }),
    enqueue: command => {
      const unsigned = {
        ...command,
        commandSeq: ++state.commandSequence,
      };
      const signed = {
        ...unsigned,
        bridgeMac: b64(
          createHmac('sha256', token).update(canonical(unsigned)).digest()
        ),
      };
      state.commands.push(signed);
      const line = `data: ${JSON.stringify(signed)}\n\n`;
      for (const client of state.clients) {
        try {
          client.write(line);
        } catch {
          state.clients.delete(client);
        }
      }
      return signed;
    },
    onReport: listener => {
      state.reportListeners.add(listener);
      return () => state.reportListeners.delete(listener);
    },
    waitForReport: (type, timeoutMs = 120_000) =>
      new Promise((resolveReport, rejectReport) => {
        const existing = state.reportBodies.find(report => report.type === type);
        if (existing) return resolveReport(existing);
        const timer = setTimeout(() => {
          state.reportListeners.delete(onReport);
          rejectReport(new Error(`Timed out waiting for evidence report ${type}`));
        }, timeoutMs);
        const onReport = report => {
          if (report.type !== type) return;
          clearTimeout(timer);
          state.reportListeners.delete(onReport);
          resolveReport(report);
        };
        state.reportListeners.add(onReport);
      }),
    close: () =>
      new Promise(ok => {
        for (const client of state.clients) client.end();
        state.clients.clear();
        server.close(ok);
      }),
  };
}
export async function createPairedEvidenceBridge(options = {}) {
  const first = createEvidenceBridge({
    ...options,
    host: '127.0.0.1',
  });
  const port = await first.listen();
  let second;
  try {
    second = createEvidenceBridge({
      ...options,
      port,
      host: '::1',
      sharedState: first.state,
    });
    await second.listen();
  } catch (error) {
    await first.close().catch(() => {});
    throw error;
  }
  return {
    port,
    state: first.state,
    enqueue: command => first.enqueue(command),
    onReport: listener => first.onReport(listener),
    waitForReport: (type, timeoutMs) => first.waitForReport(type, timeoutMs),
    close: () => Promise.all([first.close(), second?.close?.()]),
  };
}
export function listen(port, kind, { host = '127.0.0.1', readyFile } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    return Promise.reject(new Error('invalid listener port'));
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin':
          'http://localhost:4173,http://localhost:4174',
      });
      return res.end();
    }
    if (req.url === '/ready') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ kind, port, host }));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, async () => {
      if (readyFile)
        await writeFile(readyFile, JSON.stringify({ kind, port, host }));
      ok(server);
    });
  });
}
export async function atomicWrite(path, data) {
  const t = `${path}.${process.pid}.part`;
  await writeFile(t, data);
  await rename(t, path);
}
export async function startPairedListeners(
  port,
  kind,
  { listenFn = listen } = {}
) {
  const listeners = [];
  try {
    for (const host of ['127.0.0.1', '::1'])
      listeners.push(await listenFn(port, kind, { host }));
    return {
      listeners,
      close: async () =>
        Promise.all(listeners.map(s => new Promise(r => s.close(r)))),
    };
  } catch (e) {
    await Promise.all(listeners.map(s => new Promise(r => s.close(r))));
    throw e;
  }
}
export function validateExecutable(path) {
  if (!path || !path.startsWith('/'))
    throw new Error('browser executable must be absolute');
  return stat(path).then(async s => {
    if (!s.isFile()) throw new Error('browser executable must be a file');
    if ((await realpath(path)) !== path)
      throw new Error('browser executable must not be a symlink');
  });
}
export function browserIdentity({
  runId,
  runNonce,
  role,
  bridgePort,
  bridgeToken,
  armDigest,
  profileName,
  issuedAtMs = Date.now(),
  nowMs = Date.now(),
}) {
  validateProfile(profileName);
  if (
    !Number.isSafeInteger(bridgePort) ||
    bridgePort < 1024 ||
    bridgePort > 65535 ||
    !runId ||
    !runNonce ||
    !bridgeToken ||
    !armDigest
  )
    throw new Error('invalid browser evidence identity');
  const deadline = profileName === 'lan1g' ? 90 * 60_000 : 30 * 60_000;
  const expiresAtMs = Math.min(
    issuedAtMs + deadline + 5 * 60_000,
    issuedAtMs + 95 * 60_000
  );
  return {
    runId,
    runNonce,
    role,
    bridgePort,
    bridgeToken,
    origin: `http://localhost:${bridgePort}`,
    armDigest,
    profileName,
    issuedAtMs,
    expiresAtMs,
  };
}
export function browserFragment(identity) {
  return `#lanEvidence=${Buffer.from(JSON.stringify(identity)).toString('base64url')}`;
}
function secretFile(path) {
  if (!path) throw new Error('secret file required');
  return stat(path)
    .then(s => {
      if (!s.isFile() || (s.mode & 0o077) !== 0)
        throw new Error('secret must be a 0600 file');
    })
    .then(() => readFile(path));
}
function wire(socket, callback) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', data => {
    buffer += data;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      try {
        callback(JSON.parse(line));
      } catch {
        socket.destroy();
      }
    }
  });
}
function signMessage(secret, message) {
  const { mac, ...unsigned } = message;
  return b64(createHmac('sha256', secret).update(canonical(unsigned)).digest());
}
function checkMessage(secret, message) {
  try {
    const got = Buffer.from(message.mac || '', 'base64url');
    const want = Buffer.from(
      signMessage(secret, { ...message, mac: undefined }),
      'base64url'
    );
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
function sendMessage(socket, secret, message) {
  socket.write(
    JSON.stringify({ ...message, mac: signMessage(secret, message) }) + '\n'
  );
}
async function probePair(pair, port, probeFn) {
  const probe =
    probeFn ||
    (async ({ host, port: p }) => {
      const r = await fetch(
        `http://${host.includes(':') ? `[${host}]` : host}:${p}/ready`
      );
      if (!r.ok) throw new Error('listener probe failed');
    });
  await Promise.all(['127.0.0.1', '::1'].map(host => probe({ host, port })));
  return ['127.0.0.1', '::1'];
}
export async function runReceiver(args, options = {}) {
  const secret = await secretFile(args.secret);
  if (!args.connect || !args['run-id'])
    throw new Error('receiver requires --connect and --run-id');
  const port = Number(args['receiver-static-port'] ?? 4174);
  const pair = await (options.startPairedListeners || startPairedListeners)(
    port,
    'receiver',
    options
  );
  let socket;
  try {
    await probePair(pair, port, options.probeListener);
    socket = await new Promise((resolveSocket, reject) => {
      const [connectHost, connectPort] = String(args.connect).split(':');
      const s = createConnection(
        { host: connectHost, port: Number(connectPort) },
        () => resolveSocket(s)
      );
      s.once('error', reject);
    });
    const challenge = await new Promise((resolveChallenge, reject) => {
      wire(socket, m =>
        m.type === 'CHALLENGE'
          ? resolveChallenge(m)
          : reject(new Error('expected challenge'))
      );
    });
    const armDigest = args['arm-digest'] || '';
    sendMessage(socket, secret, {
      type: 'AUTH',
      runId: args['run-id'],
      runNonce: challenge.runNonce,
      challenge: challenge.challenge,
      armDigest,
      seq: 1,
    });
    sendMessage(socket, secret, {
      type: 'RECEIVER_LISTENERS_READY',
      runId: args['run-id'],
      runNonce: challenge.runNonce,
      armDigest,
      origin: `http://localhost:${port}`,
      port,
      probes: ['127.0.0.1', '::1'],
      seq: 2,
    });
    if (options.onReady) await options.onReady();
    await new Promise((resolve, reject) => {
      socket.once('close', resolve);
      socket.once('error', reject);
    });
  } finally {
    socket?.destroy();
    await pair.close();
  }
}
async function loadStartCertificatePayload(certificatePath) {
  const cert = JSON.parse(await readFile(resolve(certificatePath), 'utf8'));
  if (!cert || typeof cert !== 'object')
    throw new Error('invalid certificate file');
  const hex64 = /^[0-9a-f]{64}$/i;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !cert.certificateId ||
    !uuid.test(cert.certificateId) ||
    !cert.signature ||
    !hex64.test(String(cert.signature || ''))
  )
    throw new Error('certificate missing required fields');
  return {
    certificateId: cert.certificateId,
    certificateDigest: sha256(Buffer.from(canonical(cert))),
    certificateExpiresAtMs: cert.expiresAtMs,
  };
}

export async function runController(args, options = {}) {
  const url = normalizeSignalingUrl(args['signaling-url']);
  const cohort = validateCohort(args.control ?? 'off');
  const profile = validateProfile(args.profile ?? 'lan256');
  if (!args['run-id'] || !args.listen)
    throw new Error('controller requires --listen and --run-id');
  const secret = await secretFile(args.secret);
  const [host, portText] = String(args.listen).split(':');
  const controlPort = Number(portText);
  if (!host || !Number.isInteger(controlPort))
    throw new Error('invalid --listen');
  const runNonce = b64(Buffer.from(`${Date.now()}:${Math.random()}`));
  const challenge = b64(Buffer.from(`${runNonce}:challenge`));
  const tcp = createTcpServer();
  let socket, sender, bridge, child;
  try {
    await new Promise((resolveListen, reject) => {
      tcp.once('error', reject);
      tcp.listen(controlPort, host, resolveListen);
    });
    const receiver = await new Promise((resolveReady, reject) => {
      tcp.once('connection', s => {
        socket = s;
        sendMessage(s, secret, {
          type: 'CHALLENGE',
          runId: args['run-id'],
          runNonce,
          challenge,
          armDigest: args['arm-digest'] || '',
        });
        let last = 0;
        wire(s, m => {
          if (
            !checkMessage(secret, m) ||
            m.runId !== args['run-id'] ||
            m.runNonce !== runNonce ||
            m.seq !== last + 1
          ) {
            reject(new Error('invalid or replayed control message'));
            return s.destroy();
          }
          last = m.seq;
          if (m.type === 'AUTH') {
            if (
              m.challenge !== challenge ||
              m.armDigest !== (args['arm-digest'] || '')
            ) {
              reject(new Error('invalid authentication challenge'));
              return s.destroy();
            }
            return;
          }
          if (
            m.type === 'RECEIVER_LISTENERS_READY' &&
            m.origin ===
              `http://localhost:${args['receiver-static-port'] ?? 4174}` &&
            m.port === Number(args['receiver-static-port'] ?? 4174) &&
            JSON.stringify(m.probes) === JSON.stringify(['127.0.0.1', '::1'])
          )
            resolveReady(m);
          else {
            reject(new Error('invalid receiver ready'));
            s.destroy();
          }
        });
        s.once('error', reject);
      });
    });
    sender = await (options.startPairedListeners || startPairedListeners)(
      Number(args['sender-static-port'] ?? 4173),
      'sender',
      options
    );
    await probePair(
      sender,
      Number(args['sender-static-port'] ?? 4173),
      options.probeListener
    );
    bridge = options.createEvidenceBridge
      ? options.createEvidenceBridge({ token: b64(secret) })
      : createEvidenceBridge({ token: b64(secret) });
    const bridgePort = await bridge.listen();
    const env = {
      ...process.env,
      HOST: host,
      PORT: '5502',
      LAN_EVIDENCE_MODE: 'true',
      LAN_EVIDENCE_WS_ORIGINS: 'http://localhost:4173,http://localhost:4174',
      CORS_ORIGINS: 'http://localhost:4173,http://localhost:4174',
    };
    child = options.startSignaling
      ? await options.startSignaling({ env, host, url })
      : spawn(
          'cargo',
          [
            'run',
            '--manifest-path',
            'ponswarp-signaling-rs/Cargo.toml',
            '--release',
          ],
          { env, stdio: 'inherit' }
        );
    if (options.healthCheck) await options.healthCheck(env);
    if (options.probeOrigins)
      await options.probeOrigins(url, [
        'http://localhost:4173',
        'http://localhost:4174',
      ]);
    const identity = browserIdentity({
      runId: args['run-id'],
      runNonce,
      role: 'sender',
      bridgePort,
      bridgeToken: b64(secret),
      armDigest: args['arm-digest'] || '',
      profileName: profile,
    });
    const isPipelineOn = cohort === 'on';
    bridge.enqueue({
      type: 'START',
      identity,
      fragment: browserFragment(identity),
      runId: args['run-id'],
      runNonce,
      payload: {
        type: 'START',
        runId: args['run-id'],
        runNonce,
        pipelineOn: isPipelineOn,
        control: cohort,
        profile,
        browser: args.browser || 'chrome',
        signalingUrl: url,
        armDigest: args['arm-digest'] || '',
        hostPair: {
          senderId: args['host-pair']?.split(',')[0] || '',
          receiverId: args['host-pair']?.split(',')[1] || '',
        },
        ...(isPipelineOn && args.certificate
          ? await loadStartCertificatePayload(args.certificate)
          : {}),
      },
    });
    const controller = {
      cohort,
      profile,
      signalingUrl: url,
      runId: args['run-id'],
      runNonce,
      signalingEnv: env,
      sender,
      bridge,
    };
    if (options.launchBrowser) {
      await options.launchBrowser({ env, identity, bridge, receiver });
    } else if (options.signal) {
      // Block until an external abort signal (SIGINT/SIGTERM)
      // keeps the bridge, signaling, and TCP alive for the browser.
      if (!options.signal.aborted) {
        await new Promise(resolve => {
          options.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      }
    }
    return controller;
  } finally {
    await bridge?.close?.().catch(() => {});
    if (child?.kill) child.kill();
    await sender?.close?.().catch(() => {});
    socket?.destroy();
    await new Promise(resolve => tcp.close(resolve)).catch(() => {});
  }
}
async function loadJsonArtifacts(root) {
  const out = [];
  async function walk(dir) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile() && ent.name.endsWith('.json')) {
        try {
          const v = JSON.parse(await readFile(p, 'utf8'));
          if (v && !Array.isArray(v)) out.push(v);
        } catch {}
      }
    }
  }
  await walk(resolve(root));
  return out;
}
async function runGateCli(a) {
  if (
    !a['serial-run'] ||
    !a['pipeline-arm'] ||
    !a['run-id'] ||
    !a.secret ||
    !a.browser ||
    !a['host-pair'] ||
    !a.out ||
    !a.profile
  )
    throw new Error('gate requires documented arguments');
  const samples = (await loadJsonArtifacts(a['serial-run'])).filter(
    s => s.cohort === 'off'
  );
  if (samples.length !== 10)
    throw new Error('gate requires exactly 10 serial samples');
  const hex64 = /^[0-9a-f]{64}$/i;
  const first = samples[0];
  const stableTuple = sample => {
    const tuples = sample.hostUdpTuples;
    if (!Array.isArray(tuples) || tuples.length !== 2) return false;
    const [left, right] = tuples;
    const fields = [
      'selectedPairId',
      'localCandidateId',
      'remoteCandidateId',
      'localCandidateType',
      'remoteCandidateType',
      'localProtocol',
      'remoteProtocol',
      'selectedOrNominatedSucceeded',
    ];
    return (
      fields.every(field => left?.[field] === right?.[field]) &&
      left.localCandidateType === 'host' &&
      left.remoteCandidateType === 'host' &&
      String(left.localProtocol).toLowerCase() === 'udp' &&
      String(left.remoteProtocol).toLowerCase() === 'udp' &&
      left.selectedOrNominatedSucceeded === true &&
      Number.isFinite(left.sampledAtMs) &&
      Number.isFinite(right.sampledAtMs) &&
      right.sampledAtMs - left.sampledAtMs >= 500
    );
  };
  if (
    samples.some(
      sample =>
        sample.browser !== a.browser ||
        sample.profile !== a.profile ||
        sample.hostPair !== a['host-pair'] ||
        sample.cohort !== 'off' ||
        sample.control !== 'off' ||
        sample.valid === false ||
        sample.fixtureDigest !== first.fixtureDigest ||
        sample.browserExecutableSha256 !== first.browserExecutableSha256 ||
        sample.browserVersion !== first.browserVersion ||
        sample.signalingUrl !== first.signalingUrl ||
        sample.sourceDateEpoch !== first.sourceDateEpoch ||
        JSON.stringify(sample.serialArm) !== JSON.stringify(first.serialArm) ||
        sample.sourceSha256 !== sample.sourceReadbackSha256 ||
        sample.resumeGate !== 'pass' ||
        sample.lifecycle !== 'pass' ||
        sample.route !== 'host' ||
        sample.bridge !== true ||
        sample.evidenceFsa !== true ||
        sample.errors?.length !== 0 ||
        !stableTuple(sample) ||
        !hex64.test(String(sample.artifactSha256 || '')) ||
        !hex64.test(String(sample.hostUdpTupleDigest || '')) ||
        !hex64.test(String(sample.integrityDigest || '')) ||
        !Number.isFinite(Number(sample.ceilingMbps)) ||
        !Number.isFinite(Number(sample.sliceEncryptRatio)) ||
        !Number.isFinite(Number(sample.channelEmptyDuty))
    )
  )
    throw new Error('invalid serial evidence');
  const key = await secretFile(a.secret);
  const armPath = a['pipeline-arm'].endsWith('.manifest.json')
    ? a['pipeline-arm'].slice(0, -'.manifest.json'.length)
    : a['pipeline-arm'];
  const pipeline = await verifyArmArchive(armPath);
  if (pipeline.arm !== 'pipeline-on') throw new Error('pipeline arm mismatch');
  const serialArm = first.serialArm;
  if (
    !serialArm ||
    serialArm.arm !== 'serial-metrics' ||
    serialArm.flags?.pipeline !== false ||
    !hex64.test(String(serialArm.archiveSha256 || '')) ||
    !hex64.test(String(serialArm.treeDigest || '')) ||
    !hex64.test(String(serialArm.manifestDigest || '')) ||
    !hex64.test(String(serialArm.armDigest || '')) ||
    serialArm.normalizedSignalingUrl !== first.signalingUrl ||
    armIdentity(serialArm) === armIdentity(pipeline)
  )
    throw new Error('serial and pipeline arm identities are invalid');
  const now = Date.now(),
    ceilings = samples.map(sample => Number(sample.ceilingMbps));
  const cert = makeGateCertificate({
    version: 1,
    runId: a['run-id'],
    certificateId: randomUUID(),
    issuedAtMs: now,
    expiresAtMs: now + 1800000,
    serialArm: samples[0].serialArm || samples[0].arm,
    pipelineArm: { ...pipeline, archive: undefined },
    browser: {
      family: a.browser,
      executableSha256: samples[0].browserExecutableSha256,
      version: samples[0].browserVersion,
    },
    hostPair: {
      senderId: a['host-pair'].split(',')[0],
      receiverId: a['host-pair'].split(',')[1],
    },
    profile: a.profile,
    serialSamples: samples.map(s => ({
      sampleId: s.sampleId,
      artifactSha256: s.artifactSha256,
      fixtureDigest: s.fixtureDigest,
      hostUdpTupleDigest: s.hostUdpTupleDigest,
      integrityDigest: s.integrityDigest,
      resumeGate: 'pass',
      browserGate: 'pass',
    })),
    equations: {
      ceiling: 'payloadBytes/(transportDurationMs-sliceEncryptStallMs)*1000',
      sliceEncryptRatio: 'sliceEncryptStallMs/transportDurationMs',
      channelEmptyDuty: 'channelEmptyMs/transportDurationMs',
    },
    results: {
      validSamples: 10,
      medianCeilingMbps: median(ceilings),
      medianSliceEncryptRatio: median(
        samples.map(s => Number(s.sliceEncryptRatio))
      ),
      medianChannelEmptyDuty: median(
        samples.map(s => Number(s.channelEmptyDuty))
      ),
    },
    key,
  });
  if (
    cert.results.medianCeilingMbps < 96 ||
    cert.results.medianSliceEncryptRatio < 0.2 ||
    cert.results.medianChannelEmptyDuty < 0.15
  )
    throw new Error('serial gate thresholds failed');
  await atomicWrite(resolve(a.out), JSON.stringify(cert));
  return cert;
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log(
      'usage: lan:evidence archive-arm|controller|receiver|gate|analyze'
    );
    return;
  }
  const a = parseArgs(argv),
    mode = a._[0];
  if (!MODES.has(mode))
    throw new Error('usage: archive-arm|controller|receiver|gate|analyze');
  if (mode === 'archive-arm') {
    return archiveArm({
      dir: a.dir,
      arm: a.arm,
      sourceEpoch: Number(a['source-epoch']),
      signalingUrl: a['signaling-url'],
      out: a.out,
    });
  }
  if (mode === 'gate') return runGateCli(a);
  if (mode === 'analyze') {
    if (
      !a.input ||
      !a['require-paired-interleaved'] ||
      !a.browser ||
      !a['host-pair']
    )
      throw new Error(
        'analyze requires --input --require-paired-interleaved --browser --host-pair'
      );
    const samples = (await loadJsonArtifacts(a.input)).filter(
      s => s.browser === a.browser
    );
    return process.stdout.write(
      JSON.stringify(
        analyze(samples, {
          browsers: [a.browser],
          hostPair: a['host-pair'],
          requirePairedInterleaved: true,
          requireLan1gSoak: true,
        })
      )
    );
  }
  if (mode === 'receiver') return runReceiver(a);
  if (mode === 'controller') {
    const ac = new AbortController();
    const onSignal = () => ac.abort();
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      return await runController(a, { signal: ac.signal });
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }
  throw new Error('mode requires controller or receiver');
}
if (import.meta.url === `file://${process.argv[1]}`)
  main().catch(e => {
    console.error(`lan:evidence: ${e.message}`);
    process.exitCode = 2;
  });
