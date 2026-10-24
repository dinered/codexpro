// Run as the image's default user with no network or profile/state mounts.
import assert from 'node:assert/strict';
import {accessSync, readdirSync, realpathSync, statSync, constants} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';

assert.equal(process.getuid(), 1000, 'Runtime must use the node user');
const visited = new Set();
let files = 0;
function check(path) {
  const actual = realpathSync(path);
  if (visited.has(actual)) return;
  visited.add(actual);
  const stat = statSync(actual);
  if (stat.isDirectory()) {
    accessSync(actual, constants.R_OK | constants.X_OK);
    for (const entry of readdirSync(actual)) check(join(actual, entry));
  } else if (stat.isFile()) {
    accessSync(actual, constants.R_OK);
    files++;
  } else {
    throw new Error(`Unexpected runtime file type: ${path}`);
  }
}
for (const root of ['/app', '/opt/bridge', '/opt/websockify', '/opt/novnc']) check(root);
for (const executable of ['/opt/bridge/bridge', '/opt/bridge/router', '/usr/bin/python3',
  '/usr/bin/google-chrome-stable', '/usr/bin/Xtigervnc', '/usr/bin/openbox',
  '/usr/bin/flock', process.execPath]) accessSync(executable, constants.X_OK);
const require = createRequire('/app/package.json');
for (const dependency of ['playwright-core', 'yaml', 'linkedom']) require(dependency);
function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8'});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
}
run('/bin/sh', ['-n', '/opt/bridge/bridge']);
run('/bin/sh', ['-n', '/opt/bridge/router']);
// Upstream websockify.py is a symlink to the shell launcher named run.
run('/bin/sh', ['-n', '/opt/websockify/websockify.py']);
run('python3', ['-B', '-c', `import ast, pathlib, websockify
for root in ('/opt/bridge', '/opt/websockify/websockify'):
    for path in pathlib.Path(root).rglob('*.py'):
        ast.parse(path.read_text(), filename=str(path))
`]);
console.log(`Nonroot runtime access/imports: OK (${files} readable files; entrypoints executable)`);
