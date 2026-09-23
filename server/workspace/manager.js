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
    this.activeProjectId = null
    this._writeLock = Promise.resolve()
  }

  async init() {
    try {
      const data = JSON.parse(await fs.readFile(this.storeFile, 'utf-8'))
      this.projects = data.projects || []
      this.activeTaskId = data.activeTaskId || null
      this.activeProjectId = data.activeProjectId || null
    } catch {
      this.projects = []
    }
    // 首次运行：创建默认项目（工作区指向仓库内的 workspace/ 子文件夹，避免产物污染源码根）
    if (this.projects.length === 0) {
      this.projects.push({
        id: 'default',
        name: '默认项目',
        dir: path.join(this.baseDir, 'workspace'),
        createdAt: new Date().toISOString(),
        tasks: [],
      })
      await this.save()
    } else {
      // 归一化历史数据：dir 统一解析为绝对路径（兼容旧数据存 '.' 或相对值）
      const defaultWs = path.join(this.baseDir, 'workspace')
      const cfgDir = path.resolve(this.configDir)
      const homeDir = process.env.HOME || process.env.USERPROFILE || ''
      const legacyCfg = path.resolve(homeDir, '.miniagent')
      // 配置目录或遗留配置目录(.miniagent)下的项目目录都需要迁回项目根，
      // 因为 .miniagent 是安全网关受保护片段，且不应作为产物工作区。
      const isUnder = (abs) => {
        const a = abs.toLowerCase()
        return a === cfgDir.toLowerCase() || a === legacyCfg.toLowerCase() ||
          a.startsWith(cfgDir.toLowerCase() + path.sep) ||
          a.startsWith(legacyCfg.toLowerCase() + path.sep)
      }
      let changed = false
      for (const p of this.projects) {
        let abs = path.resolve(this.baseDir, p.dir || '.')
        if (isUnder(abs)) {
          // 自愈：早期服务 cwd 错误，把工作区建到了配置目录(.miniagent)下。
          // 迁回项目根下的同名目录，使"建项目时指定的文件夹"真正生效，
          // 避免再次因 .miniagent 是受保护片段而被安全网关拦截。
          const src = (abs.toLowerCase() === legacyCfg.toLowerCase() || abs.toLowerCase().startsWith(legacyCfg.toLowerCase() + path.sep)) ? legacyCfg : cfgDir
          const rel = path.relative(src, abs)
          abs = path.resolve(this.baseDir, rel || 'workspace')
          p.dir = abs
          changed = true
          continue
        }
        // 把仍指向仓库根的「默认项目」迁移到 workspace 子文件夹（防止产物落在源码根）
        if (p.id === 'default' && abs === this.baseDir) {
          p.dir = defaultWs
          changed = true
          continue
        }
        if (abs !== p.dir) { p.dir = abs; changed = true }
      }
      if (changed) await this.save()
    }
    // 确保工作区目录存在（list/write 需在目录存在时才正常）
    await fs.mkdir(path.join(this.baseDir, 'workspace'), { recursive: true })
  }

  // ── 持久化（串行化写入，防并发损坏）────────────────────────

  async save() {
    const run = async () => {
      await fs.mkdir(this.configDir, { recursive: true })
      const tmp = this.storeFile + '.tmp'
      await fs.writeFile(tmp, JSON.stringify({
        projects: this.projects,
        activeTaskId: this.activeTaskId,
        activeProjectId: this.activeProjectId,
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

  /**
   * 解析并准备项目目录（工作区）：
   * - 相对路径以 baseDir 为根解析为绝对路径
   * - 目录不存在则自动创建（新建文件夹模式）
   * - 已存在但不是目录则报错（选择本地文件夹模式校验）
   */
  async _resolveDir(dir) {
    const raw = (dir && typeof dir === 'string' && dir.trim()) ? dir.trim() : '.'
    const abs = path.resolve(this.baseDir, raw)
    try {
      const st = await fs.stat(abs)
      if (!st.isDirectory()) throw new Error(`路径不是目录，无法作为工作区: ${abs}`)
      return abs
    } catch (e) {
      if (e.code === 'ENOENT') {
        await fs.mkdir(abs, { recursive: true })
        return abs
      }
      throw e
    }
  }

  async createProject({ name, dir = '.' }) {
    if (!name || !name.trim()) throw new Error('项目名必填')
    if (this.projects.length >= 50) throw new Error('项目数量已达上限')
    const absDir = await this._resolveDir(dir)
    const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    this.projects.push({
      id,
      name: name.trim().slice(0, MAX_TITLE_LEN),
      dir: absDir,
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
    if (dir !== undefined) p.dir = await this._resolveDir(dir)
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

  async createTask(projectId, { title, dir } = {}) {
    const p = this.getProject(projectId)
    if (!p) throw new Error(`项目不存在: ${projectId}`)
    if (p.tasks.length >= MAX_TASKS_PER_PROJECT) throw new Error('该项目任务数已达上限')

    // 任务级工作区（可选）：用户可在新建任务时新建文件夹或选择本地文件夹。
    // 未指定时 task.dir 为 undefined，getActiveDir 会回退到项目工作区（向后兼容）。
    let taskDir = undefined
    if (dir && typeof dir === 'string' && dir.trim()) {
      taskDir = await this._resolveDir(dir.trim())
    }

    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const task = {
      id,
      title: (title || '新任务').trim().slice(0, MAX_TITLE_LEN),
      projectId,
      dir: taskDir,     // 任务专属工作区（绝对路径）；undefined = 继承项目工作区
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

  /**
   * 读取任务完整对话历史（含 tool 调用），供 /api/tasks/:id/history 与激活接口使用。
   */
  getTaskHistory(taskId) {
    const found = this.findTask(taskId)
    if (!found) return []
    return found.task.messages || []
  }

  /**
   * 返回当前激活上下文的绝对工作目录，优先级：
   *   1. 激活任务（任务级工作区优先，否则其所属项目工作区）
   *   2. 激活项目（activeProjectId 指向的项目目录）
   *   3. 首个项目目录（向后兼容）
   *   4. baseDir 兜底
   * 供文件/命令工具的 PathGuard 动态作为沙箱根（让"切换项目/选本地文件夹当工作区"真正生效）。
   */
  getActiveDir() {
    if (this.activeTaskId) {
      const found = this.findTask(this.activeTaskId)
      if (found) {
        // 任务级工作区优先；未设置则回退到项目工作区
        const td = found.task.dir
        if (td) return path.resolve(this.baseDir, td)
        return path.resolve(this.baseDir, found.project.dir)
      }
    }
    if (this.activeProjectId) {
      const p = this.getProject(this.activeProjectId)
      if (p) return path.resolve(this.baseDir, p.dir)
    }
    if (this.projects.length) return path.resolve(this.baseDir, this.projects[0].dir)
    return this.baseDir
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
   * 设置激活项目（前端"切换项目"落地）。
   * 切换项目即切换上下文：清掉当前激活任务（避免新对话仍落在旧任务/项目），
   * 落盘 activeProjectId，使 getActiveDir() 在下次对话时回到该项目目录。
   */
  async setActiveProject(projectId) {
    if (projectId !== null && !this.getProject(projectId)) throw new Error(`项目不存在: ${projectId}`)
    this.activeProjectId = projectId
    this.activeTaskId = null
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
      dir: t.dir || p.dir,   // 任务有效工作区（任务级优先，否则项目级）
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      messageCount: (t.messages || []).length,
      steps: t.steps || 0,
    }))
  }
}
