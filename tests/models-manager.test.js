/**
 * models-manager.test.js — 模型管理单测
 * 回归：编辑模型时空串/掩码 apiKey 不得覆盖真实 Key（P0 修复）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { ModelManager } from '../server/models/manager.js'

test('update 跳过空串与掩码 apiKey，保留真实 Key', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miniclaw-mm-'))
  const mm = new ModelManager(dir)
  await mm.init() // 会创建默认 Ollama 配置并落盘

  const m = await mm.add({ name: 'agnes', baseURL: 'https://x/v1', apiKey: 'sk-real-key', model: 'agnes' })

  // 前端编辑表单不回填 Key，保存时发空串 → 不得清空
  await mm.update(m.id, { name: '改名测试', apiKey: '' })
  assert.equal(mm.models.find(x => x.id === m.id).apiKey, 'sk-real-key')

  // list() 脱敏返回 '***'，客户端原样 PUT 回来 → 不得覆盖成掩码
  await mm.update(m.id, { temperature: 0.7, apiKey: '***' })
  const after = mm.models.find(x => x.id === m.id)
  assert.equal(after.apiKey, 'sk-real-key')
  assert.equal(after.temperature, 0.7)
  assert.equal(after.name, '改名测试')

  // 显式提供新 Key 才允许替换
  await mm.update(m.id, { apiKey: 'sk-new-key' })
  assert.equal(mm.models.find(x => x.id === m.id).apiKey, 'sk-new-key')
})

test('list() 对 apiKey 脱敏', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miniclaw-mm2-'))
  const mm = new ModelManager(dir)
  await mm.init()
  const m = await mm.add({ name: 'x', baseURL: 'https://x/v1', apiKey: 'sk-secret', model: 'm' })
  const listed = mm.list().find(x => x.id === m.id)
  assert.equal(listed.apiKey, '***')
})

test('save() 原子写：落盘有效 JSON 且不留 .tmp 残留', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miniclaw-mm3-'))
  const mm = new ModelManager(dir)
  await mm.init()
  await mm.add({ name: 'x', baseURL: 'https://x/v1', apiKey: 'sk-secret', model: 'm' })
  const file = path.join(dir, 'models.json')
  const tmp = file + '.tmp'
  const raw = await fs.readFile(file, 'utf-8')
  assert.doesNotThrow(() => JSON.parse(raw), '落盘内容为合法 JSON')
  // 原子写用 tmp+rename：正常情况下 rename 完成后 .tmp 已不存在
  await mm.save()
  await assert.rejects(() => fs.access(tmp), '原子写后不应残留 .tmp')
})
