import test from 'node:test'
import assert from 'node:assert/strict'
import { platforms, digest, validateBuild, verifyDigest, verifyMetadata, validateAssetMetadata } from '../scripts/release-validation.mjs'
const commit = 'a'.repeat(40)
function fixture() {
  const run = { id: 42, head_sha: commit, status: 'completed', conclusion: 'success', path: '.github/workflows/desktop-build.yml' }
  const jobs = ['Browser interaction checks', ...platforms].map(name => ({ name, status: 'completed', conclusion: 'success' }))
  const artifacts = platforms.map((platform, index) => ({ id: index, name: `open-workflow-${platform}-42`, expired: false, size_in_bytes: 100, digest: `sha256:${'b'.repeat(64)}` }))
  return { run, jobs, artifacts }
}
test('only a complete successful matrix for the expected source can be released', () => {
  const { run, jobs, artifacts } = fixture()
  assert.deepEqual(validateBuild(run, jobs, artifacts, commit).map(item => item.platform), platforms)
  assert.throws(() => validateBuild({ ...run, head_sha: 'c'.repeat(40) }, jobs, artifacts, commit), /expected commit/)
  assert.throws(() => validateBuild(run, jobs.slice(1), artifacts, commit), /Required job/)
  assert.throws(() => validateBuild(run, jobs.map(job => ({ ...job, conclusion: 'failure' })), artifacts, commit), /Required job/)
  assert.throws(() => validateBuild({ ...run, path: 'another-workflow' }, jobs, artifacts, commit), /workflow/)
})
test('expired, missing and duplicate artifacts cannot silently enter a release', () => {
  const { run, jobs, artifacts } = fixture()
  assert.throws(() => validateBuild(run, jobs, artifacts.slice(1), commit), /artifact/)
  assert.throws(() => validateBuild(run, jobs, [...artifacts, artifacts[0]], commit), /artifact/)
  assert.throws(() => validateBuild(run, jobs, artifacts.map(item => ({ ...item, expired: true })), commit), /artifact/)
})
test('archive and asset bytes must agree with their independently supplied SHA-256', () => {
  const bytes = Buffer.from('verified installer')
  verifyDigest(bytes, `sha256:${digest(bytes)}`)
  assert.throws(() => verifyDigest(Buffer.from('changed'), `sha256:${digest(bytes)}`), /mismatch/)
  const asset = { name: 'installer.exe', state: 'uploaded', size: bytes.length, digest: `sha256:${digest(bytes)}` }
  validateAssetMetadata(asset, asset.name, bytes)
  assert.throws(() => validateAssetMetadata({ ...asset, state: 'starter' }, asset.name, bytes), /Incomplete/)
  assert.throws(() => validateAssetMetadata({ ...asset, size: 1 }, asset.name, bytes), /Incomplete/)
})
test('an installer from a different version, commit or platform is rejected', () => {
  const meta = { version: '0.1.0', commit, platform: 'windows-x64' }
  verifyMetadata(meta, meta.platform, commit, meta.version)
  for (const changed of [{ version: '0.2.0' }, { commit: 'b'.repeat(40) }, { platform: 'macos-x64' }]) assert.throws(() => verifyMetadata({ ...meta, ...changed }, meta.platform, commit, meta.version), /mismatch/)
})
