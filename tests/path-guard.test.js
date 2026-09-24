/**
 * path-guard.test.js — 路径安全防护单测
 * 覆盖：目录穿越、绝对路径越界、Windows 保留设备名、fs 级校验
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { PathGuard, PathGuardError } from '../server/tools/path-guard.js'

// os.tmpdir() 在 Windows 上可能返回 8.3 短路径（ADMINI~1），而 resolveChecked 经
// fs.realpath 返回长路径（Administrator），两者做 path.relative 会误判越界。先 realpath 归一。
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'miniclaw-pg-')))
const guard = new PathGuard(base)

test('相对路径解析到 baseDir 内', () => {
  assert.equal(guard.resolve('a/b.txt'), path.join(base, 'a', 'b.txt'))
  assert.equal(guard.resolve('./x.md'), path.join(base, 'x.md'))
})

test('../ 目录穿越被拒绝', () => {
  assert.throws(() => guard.resolve('../../escape.txt'), PathGuardError)
  assert.throws(() => guard.resolve('a/../../escape.txt'), PathGuardError)
})

test('绝对路径落在 baseDir 外被拒绝', () => {
  const outside = path.resolve(base, '..', 'outside.txt')
  assert.throws(() => guard.resolve(outside), PathGuardError)
})

test('Windows 保留设备名被拒绝', () => {
  for (const p of ['CON', 'con.txt', 'aux.bat', 'NUL', 'com1']) {
    assert.throws(() => guard.resolve(p), /保留设备名/, p)
  }
})

test('空路径被拒绝', () => {
  assert.throws(() => guard.resolve(''))
  assert.throws(() => guard.resolve(null))
})

test('resolveChecked：不存在的路径默认报 PATH_NOT_FOUND', async () => {
  await assert.rejects(() => guard.resolveChecked('missing.txt'), /PATH_NOT_FOUND|路径不存在/)
})

test('resolveChecked mustExist:false：新文件路径被限制在 baseDir 内', async () => {
  const target = await guard.resolveChecked('newdir/new.txt', { mustExist: false, allowDir: false })
  const rel = path.relative(base, target)
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), `越界: ${target}`)
})

test('resolveChecked：存在的文件返回真实路径（在 baseDir 内）', async () => {
  await fs.writeFile(path.join(base, 'exists.txt'), 'ok', 'utf-8')
  const real = await guard.resolveChecked('exists.txt', { allowDir: false })
  assert.equal(path.basename(real), 'exists.txt')
  const rel = path.relative(base, real)
  assert.ok(!rel.startsWith('..'))
})

test('run_script 场景回归：filename=../../evil.bat 必须被拒绝', () => {
  assert.throws(() => guard.resolve('../../evil.bat'), PathGuardError)
  assert.throws(() => guard.resolve('..\\..\\evil.bat'), PathGuardError)
})
