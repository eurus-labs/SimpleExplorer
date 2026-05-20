// Pure-path / format helpers from src/fs.js. No Neutralino needed —
// the module is importable in node:test thanks to the `typeof window`
// guard at the top of fs.js. These are the highest-value tests because
// every navigation / drag / copy path goes through these helpers and
// a regression here corrupts URLs, breadcrumbs, and history.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePath,
  sameDrive,
  joinPath,
  parentPath,
  basename,
  pathSegments,
  parseUriList,
  formatSize,
  formatModified,
} from '../src/fs.js';

test('normalizePath: strips leading slash before drive letter', () => {
  assert.equal(normalizePath('/C:/Users/foo'), 'C:\\Users\\foo');
  assert.equal(normalizePath('/C:'), 'C:\\');
});

test('normalizePath: converts forward slashes to backslashes on Windows paths', () => {
  assert.equal(normalizePath('C:/Users/foo'), 'C:\\Users\\foo');
  assert.equal(normalizePath('D:/x/y/z'), 'D:\\x\\y\\z');
});

test('normalizePath: collapses consecutive backslashes', () => {
  assert.equal(normalizePath('C:\\\\Users\\\\foo'), 'C:\\Users\\foo');
  assert.equal(normalizePath('C:\\Users\\\\foo\\\\bar'), 'C:\\Users\\foo\\bar');
});

test('normalizePath: bare drive root gets a trailing backslash', () => {
  assert.equal(normalizePath('C:'), 'C:\\');
  assert.equal(normalizePath('Z:'), 'Z:\\');
});

test('normalizePath: leaves POSIX paths untouched', () => {
  assert.equal(normalizePath('/home/user/foo'), '/home/user/foo');
  assert.equal(normalizePath('/var/log'), '/var/log');
});

test('normalizePath: passes empty/null through', () => {
  assert.equal(normalizePath(''), '');
  assert.equal(normalizePath(null), null);
  assert.equal(normalizePath(undefined), undefined);
});

test('normalizePath: idempotent', () => {
  const inputs = ['/C:/foo', 'C:\\foo\\\\bar', 'C:', '/home/a'];
  for (const p of inputs) assert.equal(normalizePath(normalizePath(p)), normalizePath(p));
});

test('sameDrive: same letter (any case) → true', () => {
  assert.equal(sameDrive('C:\\foo', 'C:\\bar'), true);
  assert.equal(sameDrive('c:\\foo', 'C:\\bar'), true);
});

test('sameDrive: different drives → false', () => {
  assert.equal(sameDrive('C:\\foo', 'D:\\bar'), false);
});

test('sameDrive: non-Windows paths default to true (no drive concept)', () => {
  assert.equal(sameDrive('/home/a', '/home/b'), true);
  assert.equal(sameDrive('/var', '/usr'), true);
});

test('joinPath: Windows separator', () => {
  assert.equal(joinPath('C:\\Users', 'foo'), 'C:\\Users\\foo');
  assert.equal(joinPath('C:\\Users\\', 'foo'), 'C:\\Users\\foo');
  // Forward slash in parent should still emit backslash on a drive path.
  assert.equal(joinPath('C:/Users', 'foo'), 'C:\\Users\\foo');
});

test('joinPath: POSIX separator', () => {
  assert.equal(joinPath('/home/user', 'a'), '/home/user/a');
  assert.equal(joinPath('/home/user/', 'a'), '/home/user/a');
});

test('joinPath: empty parent returns child as-is', () => {
  assert.equal(joinPath('', 'a'), 'a');
});

test('parentPath: walks one level up on Windows', () => {
  assert.equal(parentPath('C:\\Users\\foo'), 'C:\\Users');
  assert.equal(parentPath('C:\\Users\\foo\\bar.txt'), 'C:\\Users\\foo');
});

test('parentPath: drive root is its own parent', () => {
  assert.equal(parentPath('C:\\'), 'C:\\');
  assert.equal(parentPath('C:'), 'C:\\');
});

test('parentPath: walks one level up on POSIX', () => {
  assert.equal(parentPath('/home/user/foo'), '/home/user');
});

test('basename: returns trailing segment', () => {
  assert.equal(basename('C:\\Users\\foo.txt'), 'foo.txt');
  assert.equal(basename('/home/user/a.json'), 'a.json');
  assert.equal(basename('loose'), 'loose');
});

test('pathSegments: Windows path splits on backslash, keeps drive', () => {
  assert.deepEqual(pathSegments('C:\\Users\\foo'), ['C:', 'Users', 'foo']);
  assert.deepEqual(pathSegments('C:\\'), ['C:']);
});

test('pathSegments: POSIX path splits on forward slash', () => {
  assert.deepEqual(pathSegments('/home/user'), ['home', 'user']);
});

test('parseUriList: file:// URIs converted to local paths', () => {
  assert.deepEqual(
    parseUriList('file:///C:/Users/foo'),
    ['C:\\Users\\foo'],
  );
});

test('parseUriList: non-file URIs dropped', () => {
  assert.deepEqual(parseUriList('http://example.com/foo'), []);
  assert.deepEqual(parseUriList('mailto:test@example.com'), []);
});

test('parseUriList: comments (# prefix) ignored', () => {
  assert.deepEqual(
    parseUriList('# header\r\nfile:///home/a\r\n# trailer'),
    ['/home/a'],
  );
});

test('parseUriList: URL-decoded paths', () => {
  assert.deepEqual(
    parseUriList('file:///C:/Users/foo%20bar'),
    ['C:\\Users\\foo bar'],
  );
});

test('parseUriList: empty / whitespace input returns []', () => {
  assert.deepEqual(parseUriList(''), []);
  assert.deepEqual(parseUriList('\n\n'), []);
});

test('formatSize: 0 / falsy returns empty string', () => {
  assert.equal(formatSize(0), '');
  assert.equal(formatSize(null), '');
  assert.equal(formatSize(undefined), '');
});

test('formatSize: bytes, KB, MB, GB scaling', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1024), '1.0 KB');
  assert.equal(formatSize(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(formatSize(2.5 * 1024 * 1024 * 1024), '2.5 GB');
});

test('formatSize: ≥ 10 of a unit drops the fractional digit', () => {
  assert.equal(formatSize(20 * 1024), '20 KB');
  assert.equal(formatSize(100 * 1024 * 1024), '100 MB');
});

test('formatModified: 0 / falsy returns empty string', () => {
  assert.equal(formatModified(0), '');
  assert.equal(formatModified(null), '');
  assert.equal(formatModified(undefined), '');
});

test('formatModified: same-day stamp returns a time-of-day string', () => {
  const now = Date.now();
  const out = formatModified(now);
  // Locale-dependent (HH:MM or h:MM AM/PM) — just assert it has a colon
  // and digits, not the full format.
  assert.match(out, /\d.*:.*\d/);
});

test('formatModified: 1-6 days ago returns "Nd ago"', () => {
  const fourDaysAgo = Date.now() - 4 * 86400e3;
  assert.match(formatModified(fourDaysAgo), /^\d+d ago$/);
});

test('formatModified: ≥ 7 days ago returns a locale date string (not "d ago")', () => {
  const tenDaysAgo = Date.now() - 10 * 86400e3;
  const out = formatModified(tenDaysAgo);
  assert.doesNotMatch(out, /d ago$/);
  // Must contain at least one digit (date number).
  assert.match(out, /\d/);
});
