/**
 * Workspace Manager - 项目/任务/历史管理器
 *
 * 数据模型：
 * - Project（项目）：一个工作区目录 + 名称
 * - Task（任务）：项目下的一次会话，含标题和完整对话历史
 * - 历史：任务内持久化的消息数组（user/assistant/tool）
 *
 * 存储：~/.miniagent/workspace.json（原子写入）
 * 任务切换时，engine 的 history 会被替换为该任务的历史。
 */

import fs from 'fs/promises'
import path from 'path'

const MAX_TITLE_LEN = 50
const MAX_TASKS_PER_PROJECT = 200

export class WorkspaceManager {
  constructor(configDir, baseDir) {
    this.configDir = configDir
    this.storeFile = path.join(configDir, 'workspace.json')
    this.baseDir = baseDir
    this.projects = []
    this.activeTaskId = null
    this._writeLock = Promise.resolve()
  }

  async init() {
    try {
      const data = JSON.parse(await fs.readFile(this.storeFile, 'utf-8'))
      this.projects = data.projects || []
      this.activeTaskId = data.activeTaskId || null
    } catch {
      this.projects = []
    }
    // 首次运行：创建默认项目
    if (this.projects.length === 0) {
      this.projects.push({
        id: 'default',
        name: '默认项目',
        dir: '.',
        createdAt: new Date().toISOString(),
        tasks: [],
      })
      await this.save()
    }
  }

  // ── 持久化（串行化写入，防并发损坏）────────────────────────

  async save() {
    const run = async () => {
      await fs.mkdir(this.configDir, { recursive: true })
      const tmp = this.storeFile + '.tmp'
      await fs.writeFile(tmp, JSON.stringify({
        projects: this.projects,
        activeTaskId: this.activeTaskId,
      }, null, 2))
      await fs.rename(tmp, this.storeFile)
    }
    this._writeLock = this._writeLock.then(run, run)
    return this._writeLock
  }

  // ── 项目 ───────────────────────────────────────────────────

  listProjects() {
    return this.projects.map(p => ({
      id: p.id,
      name: p.name,
      dir: p.dir,
      taskCount: p.tasks.length,
      createdAt: p.createdAt,
    }))
  }

  getProject(id) {
    return this.projects.find(p => p.id === id)
  }

  async createProject({ name, dir = '.' }) {
    if (!name || !name.trim()) throw new Error('项目名必填')
    if (this.projects.length >= 50) throw new Error('项目数量已达上限')
    const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    this.projects.push({
      id,
      name: name.trim().slice(0, MAX_TITLE_LEN),
      dir,
      createdAt: new Date().toISOString(),
      tasks: [],
    })
    await this.save()
    return this.getProject(id)
  }

  async updateProject(id, { name, dir }) {
    const p = this.getProject(id)
    if (!p) throw new Error(`项目不存在: ${id}`)
    if (name !== undefined) p.name = String(name).trim().slice(0, MAX_TITLE_LEN) || p.name
    if (dir !== undefined) p.dir = dir
    await this.save()
    return p
  }

  async deleteProject(id) {
    if (this.projects.length <= 1) throw new Error('至少保留一个项目')
    this.projects = this.projects.filter(p => p.id !== id)
    // 若激活任务在被删项目中，切到第一个任务
    if (this.activeTaskId && !this.findTask(this.activeTaskId)) {
      const first = this.projects[0]?.tasks[0]
      this.activeTaskId = first?.id || null
    }
    await this.save()
  }

  // ── 任务 ───────────────────────────────────────────────────

  findTask(taskId) {
    for (const p of this.projects) {
      const t = p.tasks.find(t => t.id === taskId)
      if (t) return { project: p, task: t }
    }
    return null
  }

  async createTask(projectId, { title } = {}) {
    const p = this.getProject(projectId)
    if (!p) throw new Error(`项目不存在: ${projectId}`)
    if (p.tasks.length >= MAX_TASKS_PER_PROJECT) throw new Error('该项目任务数已达上限')

    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const task = {
      id,
      title: (title || '新任务').trim().slice(0, MAX_TITLE_LEN),
      projectId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],     // 完整对话历史（含 tool 调用）
      steps: 0,
    }
    p.tasks.unshift(task)
    this.activeTaskId = id
    await this.save()
    return task
  }

  async updateTask(taskId, patch) {
    const found = this.findTask(taskId)
    if (!found) throw new Error(`任务不存在: ${taskId}`)
    const { task } = found
    if (patch.title !== undefined) task.title = String(patch.title).trim().slice(0, MAX_TITLE_LEN) || task.title
    if (patch.messages !== undefined) task.messages = patch.messages
    if (patch.steps !== undefined) task.steps = patch.steps
    task.updatedAt = new Date().toISOString()
    await this.save()
    return task
  }

  async deleteTask(taskId) {
    const found = this.findTask(taskId)
    if (!found) throw new Error(`任务不存在: ${taskId}`)
    found.project.tasks = found.project.tasks.filter(t => t.id !== taskId)
    if (this.activeTaskId === taskId) this.activeTaskId = null
    await this.save()
  }

  /**
   * 同步任务历史（engine 每次对话后调用）
   */
  async syncTaskHistory(taskId, messages, steps) {
    const found = this.findTask(taskId)
    if (!found) return
    found.task.messages = messages
    found.task.steps = steps
    found.task.updatedAt = new Date().toISOString()
    await this.save()
  }

  getActiveTask() {
    if (!this.activeTaskId) return null
    return this.findTask(this.activeTaskId)?.task || null
  }

  async setActiveTask(taskId) {
    if (taskId !== null && !this.findTask(taskId)) throw new Error(`任务不存在: ${taskId}`)
    this.activeTaskId = taskId
    await this.save()
  }

  /**
   * 列出任务（轻量元数据，不搬 messages）
   */
  listTasks(projectId) {
    const p = this.getProject(projectId)
    if (!p) return []
    return p.tasks.map(t => ({
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      messageCount: (t.messages || []).length,
      steps: t.steps || 0,
    }))
  }
}
