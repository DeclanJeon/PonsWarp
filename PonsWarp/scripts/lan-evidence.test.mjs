import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyze,
  archiveAndDigest,
  archiveArm,
  browserIdentity,
  main,
  makeGateCertificate,
  verifyArmArchive,
  verifyGateCertificate,
  nearestRank,
  parseArgs,
  validateCohort,
  normalizeSignalingUrl,
  createEvidenceBridge,
  runController,
  runReceiver,
  startPairedListeners,
} from './lan-evidence.mjs';

const canonical = value =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(',')}}`
      : JSON.stringify(value);
const mac = (key, value) =>
  createHmac('sha256', key).update(canonical(value)).digest('base64url');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function validEvidenceSample(overrides = {}) {
  const cohort = overrides.cohort ?? 'off';
  return {
    sampleId: 'sample',
    fixtureDigest: 'fixture',
    profile: 'lan256',
    browser: 'chrome',
    browserExecutableSha256: 'browser',
    hostPair: 'host-a|host-b',
    signalingUrl: 'ws://192.168.1.5:5502/ws',
    sourceDateEpoch: 1700000000,
    sourceSha256: 'source',
    sourceReadbackSha256: 'source',
    hostUdpTuples: [
      {
        selectedPairId: 'pair',
        localCandidateId: 'local',
        remoteCandidateId: 'remote',
        localCandidateType: 'host',
        remoteCandidateType: 'host',
        localProtocol: 'udp',
        remoteProtocol: 'udp',
        selectedOrNominatedSucceeded: true,
        sampledAtMs: 1_000,
      },
      {
        selectedPairId: 'pair',
        localCandidateId: 'local',
        remoteCandidateId: 'remote',
        localCandidateType: 'host',
        remoteCandidateType: 'host',
        localProtocol: 'udp',
        remoteProtocol: 'udp',
        selectedOrNominatedSucceeded: true,
        sampledAtMs: 1_500,
      },
    ],
    resumeGate: 'pass',
    lifecycle: 'pass',
    route: 'host',
    errors: [],
    cohort,
    control: cohort,
    archiveSha256: (cohort === 'off' ? 'a' : 'b').repeat(64),
    manifestDigest: (cohort === 'off' ? 'c' : 'd').repeat(64),
    armDigest: (cohort === 'off' ? 'e' : 'f').repeat(64),
    mbps: 100,
    artifactSha256: '9'.repeat(64),
    bridge: true,
    evidenceFsa: true,
    ceilingMbps: 100,
    sliceEncryptRatio: 0.25,
    channelEmptyDuty: 0.2,
    ...overrides,
  };
}

async function bridgeFixture(options = {}) {
  const artifactDir = await mkdtemp(join(tmpdir(), 'lan-evidence-'));
  const bridge = createEvidenceBridge({
    token: 't'.repeat(32),
    artifactDir,
    ...options,
  });
  const port = await bridge.listen();
  return {
    bridge,
    artifactDir,
    url: `http://127.0.0.1:${port}/v1/evidence/readback-chunk`,
    close: async () => {
      await bridge.close();
      await rm(artifactDir, { recursive: true, force: true });
    },
  };
}
function chunkHeaders(bytes, overrides = {}) {
  const metadata = {
    artifactId: 'artifact',
    index: 0,
    offset: 0,
    length: bytes.length,
    chunkSha256: digest(bytes),
    runId: 'run',
    runNonce: 'nonce',
    role: 'receiver',
    seq: 1,
    ...overrides,
  };
  return {
    Authorization: 'Bearer ' + 't'.repeat(32),
    Origin: 'http://localhost:4174',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(metadata.length),
    'X-Evidence-Artifact': metadata.artifactId,
    'X-Evidence-Index': String(metadata.index),
    'X-Evidence-Offset': String(metadata.offset),
    'X-Evidence-Length': String(metadata.length),
    'X-Evidence-Chunk-Sha256': metadata.chunkSha256,
    'X-Evidence-Run-Id': metadata.runId,
    'X-Evidence-Run-Nonce': metadata.runNonce,
    'X-Evidence-Role': metadata.role,
    'X-Evidence-Seq': String(metadata.seq),
    'X-Evidence-Mac': mac('t'.repeat(32), metadata),
  };
}

describe('LAN evidence contract', () => {
  it('is deterministic and rejects unsafe trees', async () => {
    const a = await archiveAndDigest([
      { name: 'z.txt', data: 'z' },
      { name: 'a.txt', data: 'a' },
    ]);
    const b = await archiveAndDigest([
      { name: 'a.txt', data: 'a' },
      { name: 'z.txt', data: 'z' },
    ]);
    assert.equal(a.archiveSha256, b.archiveSha256);
    assert.equal(a.armDigest, b.armDigest);
    await assert.rejects(() =>
      archiveAndDigest([{ name: '../bad', data: 'x' }])
    );
    await assert.rejects(() =>
      archiveAndDigest([
        { name: 'e\u0301', data: 'x' },
        { name: 'é', data: 'y' },
      ])
    );
  });
  it('authenticates and rejects GateCertificateV1 tampering', () => {
    const now = Date.now(),
      cert = makeGateCertificate({
        runId: 'run',
        certificateId: 'cert',
        issuedAtMs: now,
        expiresAtMs: now + 1800000,
        profile: 'lan256',
        key: 'secret',
      });
    assert.equal(verifyGateCertificate(cert, 'secret'), true);
    assert.equal(
      verifyGateCertificate({ ...cert, profile: 'lan1g' }, 'secret'),
      false
    );
    assert.equal(verifyGateCertificate(cert, 'wrong'), false);
  });
  it('uses strict mode, cohort and signaling validation', () => {
    assert.throws(() => validateCohort('ON'));
    assert.deepEqual(parseArgs(['gate', '--cohort', 'on']), {
      _: ['gate'],
      cohort: 'on',
    });
    assert.equal(
      normalizeSignalingUrl('WS://192.168.1.5:5502/ws'),
      'ws://192.168.1.5:5502/ws'
    );
    assert.throws(() => normalizeSignalingUrl('ws://localhost:5502/ws'));
  });
  it('requires paired cohorts and applies on thresholds', () => {
    const samples = [];
    for (const cohort of ['off', 'on'])
      for (let i = 0; i < 20; i++)
        samples.push(
          validEvidenceSample({
            sampleId: `${cohort}-${i}`,
            cohort,
            control: cohort,
            mbps: cohort === 'on' ? 90 : 70,
          })
        );
    assert.equal(analyze(samples, { browsers: ['chrome'] }).pairs, 20);
    assert.equal(nearestRank([1, 2, 3, 4, 5], 0.05), 1);
    assert.throws(
      () => analyze(samples.slice(1), { browsers: ['chrome'] }),
      /expected/
    );
  });
  it('accepts exactly 131072 raw bytes and finalizes verified digest', async () => {
    const f = await bridgeFixture(),
      bytes = Buffer.alloc(131072, 7),
      headers = chunkHeaders(bytes);
    try {
      const response = await fetch(f.url, {
        method: 'POST',
        headers,
        body: bytes,
      });
      assert.equal(response.status, 204);
      const report = {
        runId: 'run',
        runNonce: 'nonce',
        role: 'receiver',
        reportSeq: 1,
        type: 'FINALIZED',
        payload: {
          artifactId: 'artifact',
          expectedSize: bytes.length,
          sourceSha256: digest(bytes),
        },
      };
      const final = await fetch(f.url.replace('/readback-chunk', '/report'), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + 't'.repeat(32),
          Origin: 'http://localhost:4174',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...report, mac: mac('t'.repeat(32), report) }),
      });
      assert.equal(final.status, 204);
      assert.deepEqual(await readFile(join(f.artifactDir, 'artifact')), bytes);
    } finally {
      await f.close();
    }
  });
  it('rejects 131073 bytes and all readback authentication/order/digest failures', async () => {
    const f = await bridgeFixture();
    try {
      const oversized = Buffer.alloc(131073);
      assert.equal(
        (
          await fetch(f.url, {
            method: 'POST',
            headers: chunkHeaders(oversized),
            body: oversized,
          })
        ).status,
        400
      );
      const cases = [
        { Authorization: 'Bearer bad' },
        { 'X-Evidence-Mac': 'bad' },
        { Origin: 'http://localhost:9999' },
        { 'X-Evidence-Seq': '2' },
        { 'X-Evidence-Index': '2' },
        { 'X-Evidence-Offset': '1' },
        { 'X-Evidence-Chunk-Sha256': '0'.repeat(64) },
      ];
      for (const patch of cases) {
        const bytes = Buffer.from('x'),
          headers = { ...chunkHeaders(bytes), ...patch };
        assert.notEqual(
          (await fetch(f.url, { method: 'POST', headers, body: bytes })).status,
          204
        );
      }
      const expired = await bridgeFixture({ expiresAtMs: Date.now() - 1 });
      assert.equal(
        (
          await fetch(expired.url, {
            method: 'POST',
            headers: chunkHeaders(Buffer.from('x')),
            body: Buffer.from('x'),
          })
        ).status,
        401
      );
      await expired.close();
      assert.equal(
        await stat(join(f.artifactDir, 'artifact.part')).catch(() => null),
        null
      );
    } finally {
      await f.close();
    }
  });
  it('cleans up paired dual-stack listeners atomically on bind failure', async () => {
    const closed = [];
    let calls = 0;
    const fake = async (_port, _kind, { host }) => {
      calls++;
      if (host === '::1') throw new Error('collision');
      return {
        close: cb => {
          closed.push(host);
          cb();
        },
      };
    };
    await assert.rejects(
      () => startPairedListeners(4174, 'receiver', { listenFn: fake }),
      /collision/
    );
    assert.equal(calls, 2);
    assert.deepEqual(closed, ['127.0.0.1']);
  });
  it('archives only approved files with exact exclusions and stable bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lan-arm-'));
    try {
      await mkdir(join(root, 'run-artifacts'), { recursive: true });
      await writeFile(join(root, 'keep.txt'), 'keep');
      await writeFile(join(root, 'evidence-arm.json'), 'excluded');
      await writeFile(join(root, 'server.log'), 'excluded');
      await writeFile(join(root, 'server-123.log'), 'excluded');
      await writeFile(join(root, 'run-artifacts', 'x.json'), 'excluded');
      const out = join(root, 'arm.tar');
      const one = await archiveArm({
        dir: root,
        out,
        arm: 'pipeline-on',
        sourceEpoch: 7,
        signalingUrl: 'ws://192.168.1.5:5502/ws',
        git: 'a'.repeat(40),
      });
      const entries = await archiveAndDigest(
        [{ name: 'keep.txt', data: 'keep' }],
        { sourceDateEpoch: 7 }
      );
      assert.deepEqual(
        await archiveAndDigest([{ name: 'keep.txt', data: 'keep' }]),
        await archiveAndDigest([{ name: 'keep.txt', data: 'keep' }])
      );
      assert.equal(one.treeDigest, entries.treeDigest);
      assert.equal((await verifyArmArchive(out)).armDigest, one.armDigest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects traversal, symlink, and NFC-colliding filesystem entries', async () => {
    await assert.rejects(() => archiveAndDigest([{ name: '/ok', data: 'x' }]));
    await assert.rejects(() =>
      archiveAndDigest([{ name: 'a/../../bad', data: 'x' }])
    );
    const root = await mkdtemp(join(tmpdir(), 'lan-arm-'));
    try {
      await writeFile(join(root, 'a'), 'a');
      await symlink(join(root, 'a'), join(root, 'link'));
      await assert.rejects(
        () =>
          archiveArm({
            dir: root,
            out: join(root, 'x.tar'),
            arm: 'serial',
            sourceEpoch: 1,
            signalingUrl: 'ws://192.168.1.5:5502/ws',
            git: 'b'.repeat(40),
          }),
        /unsupported|symbolic/
      );
      await rm(join(root, 'link'));
      await writeFile(join(root, 'e\u0301'), 'x');
      await writeFile(join(root, 'é'), 'y');
      await assert.rejects(
        () =>
          archiveArm({
            dir: root,
            out: join(root, 'x.tar'),
            arm: 'serial',
            sourceEpoch: 1,
            signalingUrl: 'ws://192.168.1.5:5502/ws',
            git: 'b'.repeat(40),
          }),
        /collision/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('verifies archive identity, source epoch, signaling, flags, cohort, and distinct arms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lan-arm-'));
    try {
      const options = {
        dir: root,
        out: join(root, 'arm.tar'),
        arm: 'pipeline-on',
        sourceEpoch: 9,
        signalingUrl: 'ws://192.168.1.5:5502/ws',
        git: 'c'.repeat(40),
        flags: {
          metrics: true,
          pipeline: true,
          bridge: true,
          evidenceFsa: true,
        },
      };
      await writeFile(join(root, 'source.txt'), 'source');
      const arm = await archiveArm(options);
      await verifyArmArchive(
        options.out,
        {},
        {
          sourceDateEpoch: 9,
          normalizedSignalingUrl: options.signalingUrl,
          distinctFrom: { ...arm, armDigest: 'different' },
        }
      );
      for (const patch of [
        { sourceDateEpoch: 10 },
        { normalizedSignalingUrl: 'ws://192.168.1.6:5502/ws' },
        {
          flags: {
            metrics: false,
            pipeline: true,
            bridge: true,
            evidenceFsa: true,
          },
        },
        { arm: 'serial-metrics' },
      ])
        await assert.rejects(
          () => verifyArmArchive(options.out, { ...arm, ...patch }),
          /verification|identity|invalid arm public flags/
        );
      await assert.rejects(
        verifyArmArchive(options.out, {}, { distinctFrom: arm }),
        /identity/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('analyzes only complete, paired interleaved identities and rejects invalid evidence', () => {
    const rows = [];
    for (let i = 0; i < 20; i++) {
      rows.push(
        validEvidenceSample({
          sampleId: `off-${i}`,
          cohort: 'off',
          mbps: 90 + i,
        })
      );
      rows.push(
        validEvidenceSample({
          sampleId: `on-${i}`,
          cohort: 'on',
          mbps: 100 + i,
        })
      );
    }
    const result = analyze(rows, {
      browsers: ['chrome'],
      requirePairedInterleaved: true,
      hostPair: 'host-a|host-b',
    });
    assert.equal(result.pairs, 20);
    assert.equal(result.cohorts['chrome/off'].median, 100);
    assert.equal(result.cohorts['chrome/on'].p05, 100);
    for (const patch of [
      { cohort: 'on', sampleId: 'off-0' },
      { fixtureDigest: 'other' },
      { profile: 'lan1g' },
      { browserExecutableSha256: 'other' },
      { hostPair: 'other' },
      { signalingUrl: 'ws://192.168.1.6:5502/ws' },
      { sourceReadbackSha256: undefined },
      { resumeGate: false },
      { route: 'relay' },
      { route: 'unstable' },
      { hostUdpTuples: ['10.0.0.1:1', '10.0.0.2:2'] },
      { bridge: false },
      { evidenceFsa: false },
      { artifactSha256: 'wrong' },
      { lifecycle: 'failed' },
      { errors: ['boom'] },
      { hostUdpTuples: ['only-one'] },
    ]) {
      const bad = rows.map((s, i) => (i === 0 ? { ...s, ...patch } : s));
      assert.throws(() =>
        analyze(bad, {
          browsers: ['chrome'],
          requirePairedInterleaved: true,
          hostPair: 'host-a|host-b',
        })
      );
    }
    assert.throws(
      () => analyze(rows.slice(0, 19), { browsers: ['chrome'] }),
      /exactly/
    );
  });
  it('requires ten serial samples and rejects invalid gate evidence before certification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lan-gate-'));
    try {
      const secret = join(root, 'secret');
      await writeFile(secret, 'secret');
      await chmod(secret, 0o600);
      const serial = join(root, 'serial');
      await mkdir(serial);
      for (let i = 0; i < 9; i++)
        await writeFile(
          join(serial, `${i}.json`),
          JSON.stringify(validEvidenceSample({ sampleId: String(i) }))
        );
      await assert.rejects(
        () =>
          main([
            'gate',
            '--serial-run',
            serial,
            '--pipeline-arm',
            join(root, 'missing.tar'),
            '--run-id',
            'r',
            '--secret',
            secret,
            '--browser',
            'chrome',
            '--host-pair',
            'host-a|host-b',
            '--out',
            join(root, 'cert.json'),
            '--profile',
            'lan256',
          ]),
        /10/
      );
      await rm(serial, { recursive: true, force: true });
      await mkdir(serial);
      const pipeline = await archiveArm({
        dir: root,
        out: join(root, 'pipeline.tar'),
        arm: 'pipeline-on',
        sourceEpoch: 1,
        signalingUrl: 'ws://192.168.1.5:5502/ws',
        git: 'd'.repeat(40),
      });
      const serialArm = {
        arm: 'serial-metrics',
        sourceDateEpoch: 1,
        normalizedSignalingUrl: 'ws://192.168.1.5:5502/ws',
        flags: {
          metrics: true,
          pipeline: false,
          bridge: true,
          evidenceFsa: true,
        },
        archiveSha256: '1'.repeat(64),
        treeDigest: '2'.repeat(64),
        manifestDigest: '3'.repeat(64),
        armDigest: '4'.repeat(64),
      };
      for (let i = 0; i < 10; i++)
        await writeFile(
          join(serial, `valid-${i}.json`),
          JSON.stringify(
            validEvidenceSample({
              cohort: 'off',
              control: 'off',
              browser: 'chrome',
              profile: 'lan256',
              hostPair: 'sender,receiver',
              valid: true,
              mbps: 100 + i,
              ceilingMbps: 100 + i,
              sampleId: `valid-${i}`,
              browserVersion: '1',
              hostUdpTupleDigest: '5'.repeat(64),
              integrityDigest: '6'.repeat(64),
              serialArm,
            })
          )
        );
      const cert = await main([
        'gate',
        '--serial-run',
        serial,
        '--pipeline-arm',
        join(root, 'pipeline.tar'),
        '--run-id',
        'run',
        '--secret',
        secret,
        '--browser',
        'chrome',
        '--host-pair',
        'sender,receiver',
        '--out',
        join(root, 'cert.json'),
        '--profile',
        'lan256',
      ]);
      assert.equal(
        verifyGateCertificate(cert, 'secret', {
          runId: 'run',
          profile: 'lan256',
        }),
        true
      );
      assert.equal((await stat(join(root, 'cert.json'))).isFile(), true);
      assert.equal(pipeline.arm, 'pipeline-on');
      await chmod(secret, 0o644);
      await assert.rejects(
        () =>
          main([
            'gate',
            '--serial-run',
            serial,
            '--pipeline-arm',
            join(root, 'missing.tar'),
            '--run-id',
            'r',
            '--secret',
            secret,
            '--browser',
            'chrome',
            '--host-pair',
            'sender,receiver',
            '--out',
            join(root, 'cert.json'),
            '--profile',
            'lan256',
          ]),
        /0600/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('verifies receiver challenge signatures and closes injected listeners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lan-receiver-'));
    const secretPath = join(root, 'secret');
    await writeFile(secretPath, 'receiver-secret');
    await chmod(secretPath, 0o600);
    const seen = [];
    const server = createServer(socket => {
      socket.write(
        JSON.stringify({
          type: 'CHALLENGE',
          runId: 'run',
          runNonce: 'nonce',
          challenge: 'challenge',
          armDigest: 'arm',
          mac: mac('receiver-secret', {
            type: 'CHALLENGE',
            runId: 'run',
            runNonce: 'nonce',
            challenge: 'challenge',
            armDigest: 'arm',
          }),
        }) + '\n'
      );
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        for (const line of buffer.split('\n').slice(0, -1)) {
          const message = JSON.parse(line);
          seen.push(message);
          if (message.type === 'RECEIVER_LISTENERS_READY') socket.destroy();
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    let closed = false;
    try {
      await runReceiver(
        {
          secret: secretPath,
          connect: `127.0.0.1:${port}`,
          'run-id': 'run',
          'receiver-static-port': 4174,
          'arm-digest': 'arm',
        },
        {
          startPairedListeners: async () => ({
            close: async () => {
              closed = true;
            },
          }),
          probeListener: async () => {},
        }
      );
      assert.deepEqual(
        seen.map(m => m.type),
        ['AUTH', 'RECEIVER_LISTENERS_READY']
      );
      assert.equal(
        seen.every(m => m.mac),
        true
      );
      assert.equal(closed, true);
    } finally {
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
});
