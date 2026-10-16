import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const SCRIPT = new URL('./mirror.sh', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'vm-repo-'))
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  for (const [name, text] of Object.entries(files)) { mkdirSync(join(dir, name, '..'), { recursive: true }); writeFileSync(join(dir, name), text) }
  git('add', '-A'); git('commit', '-q', '-m', 'x')
  return dir
}
function run(repoDir, env = {}) {
  // a stand-in gcloud that records what it was asked to upload and the files it would have uploaded
  const bin = mkdtempSync(join(tmpdir(), 'vm-bin-'))
  const record = join(bin, 'record.txt')
  writeFileSync(join(bin, 'gcloud'), `#!/usr/bin/env bash\necho "$@" >> "${record.replace(/\\/g, '/')}"\nfind "\${@: -2:1}" -type f | sed "s#^\${@: -2:1}/##" | sort >> "${record.replace(/\\/g, '/')}"\n`)
  chmodSync(join(bin, 'gcloud'), 0o755)
  const r = spawnSync('bash', [SCRIPT], { env: { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, VAULT_GIT_URL: repoDir.replace(/\\/g, '/'), VAULT_BUCKET: 'test-vault-bucket', MIN_FILES: '3', ...env }, encoding: 'utf8' })
  let recorded = ''
  try { recorded = readFileSync(record, 'utf8') } catch { /* nothing was uploaded */ }
  return { ...r, recorded }
}
const note = (n) => ({ [`Notes/${n}.md`]: `# ${n}\n` })

test('it uploads the notes but never .git, the EEG folder or the PC folder view', () => {
  const repo = makeRepo({ ...note('a'), ...note('b'), ...note('c'), 'Local/EEG/session1.csv': 'eeg', 'Local/RabbitOS folder/copy.md': 'copy', 'Local/Other/keep.md': 'keep' })
  const r = run(repo)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.recorded, /storage rsync --recursive --delete-unmatched-destination-objects --quiet .* gs:\/\/test-vault-bucket\/github-mirror/)
  assert.match(r.recorded, /Notes\/a\.md/)
  assert.match(r.recorded, /Local\/Other\/keep\.md/)
  assert.ok(!/EEG|RabbitOS folder|\.git\//.test(r.recorded.split('\n').slice(1).join('\n')), r.recorded)
  assert.match(r.stdout, /"event":"vault_mirror_done"/)
})

test('an almost empty clone never touches the mirror', () => {
  const repo = makeRepo({ 'only.md': 'x' })
  const r = run(repo)
  assert.equal(r.status, 1)
  assert.equal(r.recorded, '')
  assert.match(r.stdout, /refusing to touch the mirror/)
})

test('a clone that fails, or a bad bucket name, stops with a clear message and uploads nothing', () => {
  const r1 = run('/no/such/repo')
  assert.equal(r1.status, 1)
  assert.match(r1.stdout, /clone failed/)
  assert.equal(r1.recorded, '')
  const repo = makeRepo({ ...note('a'), ...note('b'), ...note('c') })
  const r2 = run(repo, { VAULT_BUCKET: 'Bad Bucket!' })
  assert.equal(r2.status, 1)
  assert.match(r2.stdout, /bad bucket or prefix/)
})

test('the token is used only as a request header and never appears in output', () => {
  const repo = makeRepo({ ...note('a'), ...note('b'), ...note('c') })
  const r = run(repo, { GITHUB_TOKEN: 'ghp_SECRETSECRETSECRETSECRETSECRET123456' })
  assert.ok(!(r.stdout + r.stderr + r.recorded).includes('SECRETSECRET'))
})
