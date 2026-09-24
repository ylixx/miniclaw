/**
 * MiniAgent Web UI v2.1 - 前端逻辑
 *
 * 新增：
 * - 项目选择与管理
 * - 任务列表：新建/切换/重命名/删除（左栏）
 * - 任务历史：切换任务自动恢复对话
 * - 技能激活（带参数）/ 自定义技能
 * - MCP 服务器管理（添加/连接/断开/删除）
 */

const API = ''
let isLoading = false
let editingModelId = null
let currentProjectId = null
let currentTaskId = null
let taskDirMap = {}      // taskId -> 有效工作区绝对路径（来自 listTasks）
let _thinkBubble = null  // 当前流式"思考气泡"元素

const $ = (sel) => document.querySelector(sel)
const chatMessages = $('#chatMessages')
const chatInput = $('#chatInput')
const btnSend = $('#btnSend')
const btnReset = $('#btnReset')
const statusIndicator = $('#statusIndicator')
const statusText = $('#statusText')
const executionLog = $('#executionLog')
const toolsList = $('#toolsList')
const tokenStat = $('#tokenStat')

// ── 初始化 ────────────────────────────────────────────────

async function init() {
  await loadStatus()
  setupEventListeners()
  setupWebSocket()
}

async function loadStatus() {
  try {
    const res = await fetch(`${API}/api/status`)
    const data = await res.json()
    renderTools(data.tools)

    // 项目
    if (data.projects && data.projects.length > 0) {
      if (!currentProjectId || !data.projects.find(p => p.id === currentProjectId)) {
        // 优先用后端持久化的激活项目（刷新后保持用户切换结果），否则第一个项目（向后兼容）
        currentProjectId = (data.activeProjectId && data.projects.find(p => p.id === data.activeProjectId)?.id)
          || data.projects[0].id
      }
      renderProjectName(data.projects)
      await loadTasks()
    }

    // 激活任务
    if (data.activeTaskId && data.activeTaskId !== currentTaskId) {
      await switchTask(data.activeTaskId, { silent: true })
    }
  } catch (err) {
    console.error('Failed to load status:', err)
  }
}

function renderTools(tools) {
  toolsList.innerHTML = tools.map(t =>
    `<div class="tool-item">${t.mcp ? '🔌' : '🔧'} <span class="name">${t.name}</span> - ${t.description}</div>`
  ).join('')
}

// ── 项目 ──────────────────────────────────────────────────

function renderProjectName(projects) {
  const p = projects.find(p => p.id === currentProjectId)
  $('#currentProjectName').textContent = p ? p.name : '未选择'
}

async function loadProjectsList() {
  const res = await fetch(`${API}/api/projects`)
  const projects = await res.json()
  renderProjectName(projects)
  $('#projectsList').innerHTML = projects.map(p => `
    <div class="model-card ${p.id === currentProjectId ? 'active' : ''}">
      <div class="model-card-info">
        <h5>${p.id === currentProjectId ? '✅ ' : ''}${escapeHtml(p.name)}</h5>
        <div class="meta">📁 ${escapeHtml(p.dir)} · ${p.taskCount} 个任务</div>
      </div>
      <div class="model-card-actions">
        ${p.id !== currentProjectId ? `<button class="btn-activate" onclick="selectProject('${p.id}')">切换</button>` : ''}
        ${p.id !== 'default' ? `<button onclick="deleteProject('${p.id}')">删除</button>` : ''}
      </div>
    </div>
  `).join('') || '<div class="log-empty">暂无项目</div>'
}

async function selectProject(id) {
  let name = id
  try {
    const res = await fetch(`${API}/api/projects/${id}/activate`, { method: 'POST' })
    const data = await res.json()
    if (data.error) return alert(`切换失败: ${data.error}`)
    if (data.project?.name) name = data.project.name
  } catch (e) {
    console.error('activate project failed:', e)
    return alert('切换失败：服务端未响应（请确认后端已加载新代码并重启）')
  }
  // 切换项目 = 切换上下文：清掉当前任务，下一次对话会在新项目下建任务
  currentProjectId = id
  currentTaskId = null
  await loadProjectsList()
  await loadTasks()
  await loadStatus()
  renderChatTitle()
  showToast(`已切换到「${name}」`)
}

// 轻量顶部提示（非阻塞，2 秒自动淡出）
function showToast(msg) {
  let t = document.getElementById('wb-toast')
  if (!t) {
    t = document.createElement('div')
    t.id = 'wb-toast'
    t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#1f2937;color:#fff;padding:8px 16px;border-radius:8px;z-index:9999;opacity:0;transition:opacity .25s;pointer-events:none;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.25)'
    document.body.appendChild(t)
  }
  t.textContent = msg
  t.style.opacity = '1'
  clearTimeout(t._timer)
  t._timer = setTimeout(() => { t.style.opacity = '0' }, 2000)
}

async function createProject() {
  const name = $('#pName').value.trim()
  const dir = $('#pDir').value.trim() || '.'
  if (!name) return alert('请输入项目名称')
  const res = await fetch(`${API}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, dir }),
  })
  const data = await res.json()
  if (data.error) return alert(`创建失败: ${data.error}`)
  $('#pName').value = ''
  currentProjectId = data.project.id
  await loadProjectsList()
  await loadTasks()
  renderChatTitle()
}

async function deleteProject(id) {
  if (!confirm('删除项目将同时删除其下所有任务与历史，确定？')) return
  await fetch(`${API}/api/projects/${id}`, { method: 'DELETE' })
  if (currentProjectId === id) {
    currentProjectId = null
    currentTaskId = null
  }
  await loadProjectsList()
  await loadTasks()
  await loadStatus()
}

// ── 工作区选择（新建/选本地文件夹）─────────────────────────

function setupWorkspacePicker() {
  const radios = document.querySelectorAll('input[name="wsMode"]')
  const pickRow = document.getElementById('wsPickRow')
  const hint = document.getElementById('wsHint')
  const sync = () => {
    const mode = document.querySelector('input[name="wsMode"]:checked')?.value || 'new'
    if (pickRow) pickRow.classList.toggle('hidden', mode !== 'pick')
    if (hint) hint.textContent = mode === 'pick'
      ? '粘贴本地文件夹的绝对路径（如 D:\\work\\myproject）；或点"浏览"选文件夹名（建在服务端工作区内）。后端会校验目录存在。'
      : '输入文件夹名（建在服务端工作区内）或绝对路径；后端会自动创建不存在的目录。'
  }
  radios.forEach(r => r.addEventListener('change', sync))
  sync()
  const picker = document.getElementById('pDirPicker')
  if (picker) picker.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]
    if (f) {
      // 浏览器安全限制：仅暴露相对于所选目录的名（webkitRelativePath 首段）
      const name = (f.webkitRelativePath || f.name).split(/[/\\]/)[0]
      const input = document.getElementById('pDir')
      if (input) input.value = name
    }
    e.target.value = ''
  })
}

// 任务弹窗的工作区选择（与项目弹窗同逻辑，但用独立的 id，避免冲突）
let _taskWsBound = false
function taskWsSync() {
  const mode = document.querySelector('input[name="taskWsMode"]:checked')?.value || ''
  const pickRow = document.getElementById('taskWsPickRow')
  const hint = document.getElementById('taskWsHint')
  if (pickRow) pickRow.classList.toggle('hidden', mode !== 'pick')
  if (hint) {
    if (mode === 'pick') hint.textContent = '粘贴本地文件夹的绝对路径（如 D:\\work\\mytask）；或点"浏览"选文件夹名（建在服务端工作区内）。后端会校验目录存在。'
    else if (mode === 'new') hint.textContent = '输入文件夹名（建在服务端工作区内）或绝对路径；后端会自动创建不存在的目录。'
    else if (mode === 'inherit') hint.textContent = '沿用当前项目的工作区（与项目共享同一文件夹）。'
    else hint.textContent = ''
  }
}
function onTaskDirPick(e) {
  const f = e.target.files && e.target.files[0]
  if (f) {
    const name = (f.webkitRelativePath || f.name).split(/[/\\]/)[0]
    const input = document.getElementById('taskDir')
    if (input) input.value = name
  }
  e.target.value = ''
}
function setupTaskWorkspacePicker() {
  if (!_taskWsBound) {
    document.querySelectorAll('input[name="taskWsMode"]').forEach(r => r.addEventListener('change', taskWsSync))
    const picker = document.getElementById('taskDirPicker')
    if (picker) picker.addEventListener('change', onTaskDirPick)
    _taskWsBound = true
  }
  taskWsSync()
}

// ── 任务 ──────────────────────────────────────────────────

async function loadTasks() {
  if (!currentProjectId) {
    $('#taskList').innerHTML = '<div class="task-empty">请先选择项目</div>'
    $('#taskCount').textContent = '0'
    return
  }
  const res = await fetch(`${API}/api/projects/${currentProjectId}/tasks`)
  const tasks = await res.json()
  taskDirMap = {}
  tasks.forEach(t => { taskDirMap[t.id] = t.dir || '' })
  $('#taskCount').textContent = tasks.length
  $('#taskList').innerHTML = tasks.map(t => `
    <div class="task-item ${t.id === currentTaskId ? 'active' : ''}" onclick="switchTask('${t.id}')" title="${escapeHtml(t.title)}">
      <div class="task-item-title">${t.id === currentTaskId ? '● ' : ''}${escapeHtml(t.title)}</div>
      <div class="task-item-meta">${t.messageCount} 条消息 · ${formatTime(t.updatedAt)}</div>
      <div class="task-item-actions">
        <button onclick="event.stopPropagation();renameTask('${t.id}', '${escapeHtml(t.title).replace(/'/g, '&#39;')}')" title="重命名">✏️</button>
        <button onclick="event.stopPropagation();deleteTask('${t.id}')" title="删除">🗑</button>
      </div>
    </div>
  `).join('') || '<div class="task-empty">暂无任务，点击上方新建</div>'
}

function createNewTask() {
  $('#taskTitle').value = ''
  // 默认预选「继承项目工作区」：普通任务不建文件夹，直接复用项目目录；
  // 需要隔离时再手动切换为「新建文件夹 / 选本地文件夹」
  document.querySelectorAll('input[name="taskWsMode"]').forEach(r => { r.checked = (r.value === 'inherit') })
  const td = $('#taskDir'); if (td) td.value = ''
  const pr = $('#taskWsPickRow'); if (pr) pr.classList.add('hidden')
  const hint = $('#taskWsHint'); if (hint) hint.textContent = ''
  $('#taskModal').classList.remove('hidden')
  setupTaskWorkspacePicker()
  setTimeout(() => $('#taskTitle').focus(), 50)
}

async function confirmCreateTask() {
  const title = $('#taskTitle').value.trim() || `任务 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
  if (!currentProjectId) return alert('请先在项目中选择或创建一个项目')

  // 工作区：默认继承项目（不建文件夹）；未勾选时也按继承处理，不再强制弹窗
  const mode = document.querySelector('input[name="taskWsMode"]:checked')?.value || 'inherit'
  let dir = ''
  if (mode === 'new' || mode === 'pick') {
    dir = $('#taskDir').value.trim()
    if (!dir) return alert(mode === 'pick' ? '请填写或浏览选择本地文件夹路径' : '请填写新建文件夹名称或绝对路径')
  }
  // inherit 模式不传 dir，后端回退到项目工作区

  const res = await fetch(`${API}/api/projects/${currentProjectId}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, dir: mode === 'inherit' ? undefined : dir }),
  })
  const data = await res.json()
  if (data.error) return alert(`创建失败: ${data.error}`)
  closeModal('taskModal')
  currentTaskId = data.task.id
  taskDirMap[data.task.id] = data.task.dir || taskDirMap[data.task.id] || ''
  if (!taskDirMap[data.task.id]) {
    // 回退到项目工作区（inherit 模式时后端未返回任务级 dir）
    const pres = await fetch(`${API}/api/projects/${currentProjectId}`).then(r => r.json()).catch(() => null)
    taskDirMap[data.task.id] = pres?.dir || ''
  }
  renderChatWelcome(title)
  await loadTasks()
  renderChatTitle()
}

async function switchTask(taskId, { silent } = {}) {
  const res = await fetch(`${API}/api/tasks/${taskId}/activate`, { method: 'POST' })
  const data = await res.json()
  if (data.error) return
  currentTaskId = taskId
  // 找到所属项目并切换
  const tres = await fetch(`${API}/api/tasks/${taskId}`)
  const tdata = await tres.json()
  // 记录本任务的有效工作区（任务级优先，否则项目级）
  taskDirMap[taskId] = (tdata.task && tdata.task.dir) || (tdata.project && tdata.project.dir) || taskDirMap[taskId] || ''
  if (tdata.project && tdata.project.id !== currentProjectId) {
    currentProjectId = tdata.project.id
    await loadTasks()
  }
  renderHistory(data.messages || [])
  renderChatTitle()
  executionLog.innerHTML = '<div class="log-empty">已切换任务</div>'
  hidePlan()
  if (!silent) await loadTasks()
}

function renderHistory(messages) {
  chatMessages.innerHTML = ''
  window._thinkHadBubble = false
  window._lastThinkBubble = null
  _thinkBubble = null
  let hasContent = false
  for (const msg of messages) {
    if (msg.role === 'user') {
      appendMessage('user', msg.content)
      hasContent = true
    } else if (msg.role === 'assistant' && msg.content) {
      appendMessage('assistant', msg.content)
      hasContent = true
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        appendToolCall(tc.function.name, JSON.parse(tc.function.arguments || '{}'))
        hasContent = true
      }
    } else if (msg.role === 'tool') {
      appendToolResult(msg.tool_call_id, msg.content)
      hasContent = true
    }
  }
  if (!hasContent) {
    renderChatWelcome()
  }
}

async function renameTask(taskId, currentTitle) {
  const newTitle = prompt('新的任务标题：', currentTitle)
  if (!newTitle || newTitle === currentTitle) return
  await fetch(`${API}/api/tasks/${taskId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: newTitle }),
  })
  await loadTasks()
  if (taskId === currentTaskId) renderChatTitle()
}

async function deleteTask(taskId) {
  if (!confirm('删除该任务及其全部历史，确定？')) return
  await fetch(`${API}/api/tasks/${taskId}`, { method: 'DELETE' })
  if (taskId === currentTaskId) {
    currentTaskId = null
    renderChatWelcome()
    renderChatTitle()
  }
  await loadTasks()
}

function renderChatTitle() {
  const titleEl = $('#chatTitle')
  const wsEl = $('#chatWorkspace')
  if (currentTaskId) {
    titleEl.textContent = '对话'
    titleEl.dataset.taskTitle = ''
    if (wsEl) wsEl.textContent = taskDirMap[currentTaskId] || ''
  } else {
    titleEl.textContent = '未选择任务'
    if (wsEl) wsEl.textContent = ''
  }
}

function renderChatWelcome(title) {
  chatMessages.innerHTML = `
    <div class="welcome">
      <h3>${title ? '✨ ' + escapeHtml(title) : '👋 你好！我是 MiniAgent'}</h3>
      <p>${title ? '新任务已创建，开始对话吧' : '一个专为小模型设计的办公助手。'}</p>
      <ul>
        <li>📁 整理文件和文件夹</li>
        <li>📄 读写 CSV、JSON 文件</li>
        <li>📝 批量处理文本</li>
        <li>📊 生成简单报告</li>
      </ul>
    </div>
  `
}

// ── 技能 ──────────────────────────────────────────────────

async function openSkillsModal() {
  $('#skillsModal').classList.remove('hidden')
  await loadSkillsFullList()
}

async function loadSkillsFullList() {
  const res = await fetch(`${API}/api/skills`)
  const skills = await res.json()
  $('#skillsFullList').innerHTML = skills.map(s => `
    <div class="model-card ${s.active ? 'active' : ''}">
      <div class="model-card-info">
        <h5>${s.active ? '✅ ' : '⚡ '}${escapeHtml(s.description)}</h5>
        <div class="meta">${escapeHtml(s.name)}${s.steps?.length ? ' · 工具链: ' + s.steps.join('→') : ''}${s.builtin ? ' · 内置' : ' · 自定义'}</div>
      </div>
      <div class="model-card-actions">
        ${s.active
          ? `<button onclick="deactivateSkill('${s.name}')">停用</button>`
          : `<button class="btn-activate" onclick="activateSkill('${s.name}')">激活</button>`}
        ${!s.builtin ? `<button onclick="deleteSkill('${s.name}')">删除</button>` : ''}
      </div>
    </div>
  `).join('')
}

async function activateSkill(name) {
  // 获取技能参数定义
  const res = await fetch(`${API}/api/skills`)
  const skills = await res.json()
  const skill = skills.find(s => s.name === name)
  const params = {}
  if (skill?.params?.length) {
    for (const p of skill.params) {
      if (!p.default) {
        const v = prompt(`${p.label || p.key}：`, '')
        if (v === null) return // 取消
        params[p.key] = v
      }
    }
  }
  const ares = await fetch(`${API}/api/skills/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, params }),
  })
  const data = await ares.json()
  if (data.error) return alert(`激活失败: ${data.error}`)
  await loadSkillsFullList()
}

async function deactivateSkill(name) {
  await fetch(`${API}/api/skills/deactivate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  await loadSkillsFullList()
}

async function createCustomSkill() {
  const name = $('#skName').value.trim()
  const description = $('#skDesc').value.trim()
  const instruction = $('#skInstruction').value.trim()
  if (!name || !instruction) return alert('技能名称和指令必填')
  const res = await fetch(`${API}/api/skills/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, instruction }),
  })
  const data = await res.json()
  if (data.error) return alert(`创建失败: ${data.error}`)
  $('#skName').value = ''
  $('#skDesc').value = ''
  $('#skInstruction').value = ''
  await loadSkillsFullList()
}

async function deleteSkill(name) {
  if (!confirm(`删除自定义技能 ${name}？`)) return
  await fetch(`${API}/api/skills/${name}`, { method: 'DELETE' })
  await loadSkillsFullList()
}

// 从 zip 包安装技能：读取文件 → 以原始字节 POST → 刷新列表
function installSkillFromZipFile(file) {
  const btn = document.getElementById('btnInstallSkill')
  const orig = btn ? btn.textContent : '📦 安装 zip 技能包'
  if (btn) { btn.disabled = true; btn.textContent = '安装中…' }
  const reader = new FileReader()
  reader.onload = async () => {
    try {
      const buf = new Uint8Array(reader.result)
      const res = await fetch(`${API}/api/skills/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: buf,
      })
      const data = await res.json()
      if (data.ok) {
        alert(`技能「${data.skill.name}」安装成功！可在上方列表激活。`)
        await loadSkillsFullList()
      } else {
        alert('安装失败：' + (data.error || '未知错误'))
      }
    } catch (err) {
      alert('安装出错：' + err.message)
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig }
    }
  }
  reader.onerror = () => {
    alert('读取文件失败')
    if (btn) { btn.disabled = false; btn.textContent = orig }
  }
  reader.readAsArrayBuffer(file)
}

// ── MCP ───────────────────────────────────────────────────

async function openMcpModal() {
  $('#mcpModal').classList.remove('hidden')
  await loadMcpServers()
}

async function loadMcpServers() {
  const res = await fetch(`${API}/api/mcp`)
  const servers = await res.json()
  $('#mcpServersList').innerHTML = servers.map(s => `
    <div class="model-card">
      <div class="model-card-info">
        <h5>${s.connected ? '🟢' : '⚪'} ${escapeHtml(s.name)}</h5>
        <div class="meta">${escapeHtml(s.type)} · ${s.tools.length} 个工具${s.error ? ' · ' + escapeHtml(s.error) : ''}</div>
      </div>
      <div class="model-card-actions">
        ${s.connected
          ? `<button onclick="disconnectMcp('${s.name}')">断开</button>`
          : `<button class="btn-activate" onclick="connectMcp('${s.name}')">连接</button>`}
        <button onclick="deleteMcpServer('${s.name}')">删除</button>
      </div>
    </div>
  `).join('') || '<div class="log-empty">暂未配置 MCP 服务器</div>'
}

function onMcpTypeChange() {
  const type = $('#mcpType').value
  $('#mcpStdioRow').classList.toggle('hidden', type !== 'stdio')
  $('#mcpHttpRow').classList.toggle('hidden', type === 'stdio')
}

async function addMcpServer() {
  const name = $('#mcpName').value.trim()
  const type = $('#mcpType').value
  if (!name) return alert('请填写服务器名称')
  const body = { name, type }
  if (type === 'stdio') {
    body.command = $('#mcpCommand').value.trim()
    body.args = $('#mcpArgs').value.trim().split(/\s+/).filter(Boolean)
    if (!body.command) return alert('请填写命令')
  } else {
    body.url = $('#mcpUrl').value.trim()
    if (!body.url) return alert('请填写 URL')
  }
  const res = await fetch(`${API}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (data.error) return alert(`添加失败: ${data.error}`)
  $('#mcpName').value = ''
  await loadMcpServers()
}

async function connectMcp(name) {
  const res = await fetch(`${API}/api/mcp/${name}/connect`, { method: 'POST' })
  const data = await res.json()
  if (data.error) return alert(`连接失败: ${data.error}`)
  await loadMcpServers()
  await loadStatus()
}

async function connectAllMcp() {
  await fetch(`${API}/api/mcp/connect-all`, { method: 'POST' })
  await loadMcpServers()
  await loadStatus()
}

async function disconnectMcp(name) {
  await fetch(`${API}/api/mcp/${name}/disconnect`, { method: 'POST' })
  await loadMcpServers()
  await loadStatus()
}

async function deleteMcpServer(name) {
  if (!confirm(`删除 MCP 服务器 ${name}？`)) return
  await fetch(`${API}/api/mcp/${name}`, { method: 'DELETE' })
  await loadMcpServers()
  await loadStatus()
}

// ── 模型管理 ──────────────────────────────────────────────

async function openModelsModal() {
  $('#modelsModal').classList.remove('hidden')
  await loadModelsList()
  resetForm()
}

function closeModelsModal() {
  $('#modelsModal').classList.add('hidden')
}

function closeModal(id) {
  $('#' + id).classList.add('hidden')
}

async function loadModelsList() {
  try {
    const res = await fetch(`${API}/api/models`)
    const models = await res.json()
    $('#modelsList').innerHTML = models.map(m => `
      <div class="model-card ${m.isActive ? 'active' : ''}">
        <div class="model-card-info">
          <h5>${m.isActive ? '✅ ' : ''}${escapeHtml(m.name)}</h5>
          <div class="meta">${escapeHtml(m.provider)} · ${escapeHtml(m.model)} · ${escapeHtml((m.baseURL || '').slice(0, 40))}</div>
        </div>
        <div class="model-card-actions">
          ${!m.isActive ? `<button class="btn-activate" onclick="activateModel('${m.id}')">启用</button>` : ''}
          <button onclick="editModel('${m.id}')">编辑</button>
          <button onclick="deleteModel('${m.id}')">删除</button>
        </div>
      </div>
    `).join('') || '<div class="log-empty">暂无配置的模型</div>'
  } catch (err) {
    console.error('Failed to load models:', err)
  }
}

function onProviderChange() {
  const provider = $('#mProvider').value
  const templates = {
    ollama: { baseURL: 'http://localhost:11434/v1', model: 'qwen3:4b', apiKey: '***' },
    deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
    moonshot: { baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    agnes: { baseURL: 'https://apihub.agnes-ai.cn/v1', model: 'agnes-2.5-flash', apiKey: '' },
    custom: { baseURL: '', model: '' },
  }
  const t = templates[provider] || templates.custom
  if (!$('#mName').value || editingModelId === null) {
    $('#mBaseURL').value = t.baseURL || ''
    $('#mModel').value = t.model || ''
    if (t.apiKey) $('#mApiKey').value = t.apiKey
  }
}

async function saveModel() {
  const data = {
    name: $('#mName').value || '未命名',
    provider: $('#mProvider').value,
    baseURL: $('#mBaseURL').value,
    apiKey: $('#mApiKey').value,
    model: $('#mModel').value,
    maxTokens: parseInt($('#mMaxTokens').value) || 2048,
    contextLength: parseInt($('#mContextLength').value) || 32768,
    temperature: parseFloat($('#mTemperature').value) || 0.3,
  }

  if (!data.baseURL || !data.model) {
    showTestResult('error', '请填写 API 地址和模型 ID')
    return
  }

  try {
    if (editingModelId) {
      await fetch(`${API}/api/models/${editingModelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    } else {
      await fetch(`${API}/api/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    }
    resetForm()
    await loadModelsList()
    await loadStatus()
    showTestResult('success', '保存成功')
  } catch (err) {
    showTestResult('error', `保存失败: ${err.message}`)
  }
}

function editModel(id) {
  fetch(`${API}/api/models`)
    .then(r => r.json())
    .then(models => {
      const m = models.find(m => m.id === id)
      if (!m) return
      editingModelId = id
      $('#modelFormTitle').textContent = '编辑模型'
      $('#mName').value = m.name || ''
      $('#mProvider').value = m.provider || 'custom'
      $('#mBaseURL').value = m.baseURL || ''
      $('#mApiKey').value = ''
      $('#mModel').value = m.model || ''
      $('#mMaxTokens').value = m.maxTokens || 2048
      $('#mContextLength').value = m.contextLength || 32768
      $('#mTemperature').value = m.temperature || 0.3
    })
}

async function deleteModel(id) {
  if (!confirm('确定删除这个模型配置？')) return
  await fetch(`${API}/api/models/${id}`, { method: 'DELETE' })
  await loadModelsList()
  await loadStatus()
}

async function activateModel(id) {
  await fetch(`${API}/api/models/${id}/activate`, { method: 'POST' })
  await loadModelsList()
  await loadStatus()
}

async function testModel() {
  const data = {
    baseURL: $('#mBaseURL').value,
    model: $('#mModel').value,
    apiKey: $('#mApiKey').value,
  }
  showTestResult('', '测试中...')
  try {
    const res = await fetch(`${API}/api/models/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const result = await res.json()
    if (result.success) {
      showTestResult('success', `连接成功！回复: ${result.reply}`)
    } else {
      showTestResult('error', `连接失败: ${result.error}`)
    }
  } catch (err) {
    showTestResult('error', `请求失败: ${err.message}`)
  }
}

async function fetchModels() {
  const baseURL = $('#mBaseURL').value
  const apiKey = $('#mApiKey').value
  if (!baseURL) {
    showTestResult('error', '请先填写 API 地址')
    return
  }
  showTestResult('', '获取模型列表中...')
  try {
    const res = await fetch(`${API}/api/models/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL, apiKey }),
    })
    const result = await res.json()
    if (result.success && result.models.length > 0) {
      const select = $('#mModelSelect')
      select.innerHTML = '<option value="">-- 选择模型 (' + result.models.length + ' 个) --</option>'
      for (const m of result.models) {
        select.innerHTML += `<option value="${m.id}">${m.name}</option>`
      }
      select.classList.remove('hidden')
      showTestResult('success', `获取到 ${result.models.length} 个模型`)
    } else {
      showTestResult('error', result.error || '未获取到模型')
      $('#mModelSelect').classList.add('hidden')
    }
  } catch (err) {
    showTestResult('error', `获取失败: ${err.message}`)
  }
}

function onModelSelect() {
  const select = $('#mModelSelect')
  if (select.value) {
    $('#mModel').value = select.value
  }
}

function showTestResult(type, msg) {
  const el = $('#testResult')
  el.className = `test-result ${type}`
  el.textContent = msg
  el.classList.remove('hidden')
}

function resetForm() {
  editingModelId = null
  $('#modelFormTitle').textContent = '添加新模型'
  $('#mName').value = ''
  $('#mProvider').value = 'ollama'
  $('#mBaseURL').value = 'http://localhost:11434/v1'
  $('#mApiKey').value = ''
  $('#mModel').value = ''
  $('#mMaxTokens').value = 2048
  $('#mContextLength').value = 32768
  $('#mTemperature').value = 0.3
  $('#testResult').classList.add('hidden')
}

// ── 对话 ──────────────────────────────────────────────────

async function sendMessage() {
  const message = chatInput.value.trim()
  // 先快照图片/附件数据：下面 removeChatImage() 会把 _chatImageDataUrl 置空，
  // 必须在清空之前取走，否则 requestBody.image 会变成 null（图片白传、识别不到）。
  const chatImage = _chatImageDataUrl
  const hasImage = chatImage !== null
  const chatFiles = _chatFileAttach.slice()
  const hasAttach = chatFiles.length > 0

  if (!message && !hasImage && !hasAttach) return
  if (isLoading) return

  // 无任务时自动新建
  if (!currentTaskId) {
    if (!currentProjectId) {
      return appendMessage('system', '请先在左栏选择或创建项目')
    }
    const title = hasImage ? '图片分析任务' : (hasAttach ? '文件分析任务' : message.slice(0, 30))
    const res = await fetch(`${API}/api/projects/${currentProjectId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    const data = await res.json()
    if (data.error) return appendMessage('system', `创建任务失败: ${data.error}`)
    currentTaskId = data.task.id
    renderChatTitle()
    await loadTasks()
    renderChatWelcome(data.task.title)
  }

  // 发送用户消息
  const userMessageContent = hasImage ? 
    `📷 ${message}\n\n[图片已上传]` : 
    (hasAttach ? `${message}\n\n[已上传 ${chatFiles.length} 个文件]` : message)
  
  appendMessage('user', userMessageContent)
  
  // 如果有图片，显示图片预览
  if (hasImage) {
    appendImageToChat(chatImage)
  }
  
  // 清空输入和附件（数据已快照，UI 同步清掉）
  chatInput.value = ''
  removeChatImage()
  _chatFileAttach = []
  renderAttachChips()
  
  setLoading(true)
  hidePlan()
  window._live = { gotTool: false, gotResponse: false }
  window._thinkHadBubble = false
  window._lastThinkBubble = null
  _thinkBubble = null
  showThinking('● 思考中…')

  try {
    // 文本类附件内容内联进消息（模型可直接读到文件内容）
    let fullMessage = message
    for (const f of chatFiles) {
      fullMessage += `\n\n[附件文件 ${f.name}]\n${f.content}`
    }

    const requestBody = { message: fullMessage, taskId: currentTaskId }
    
    // 如果有图片，添加到请求中（用上面快照的 chatImage，避免被 removeChatImage 清空）
    if (hasImage) {
      requestBody.image = chatImage
      requestBody.hasImage = true
    }
    
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    const data = await res.json()

    if (data.error) {
      appendMessage('system', `错误: ${data.error}`)
    } else {
      // 优先采用 WebSocket 实时流；仅在未收到流事件时回退到请求载荷，避免重复渲染
      if (!window._live.gotTool && data.steps) {
        for (const step of data.steps) {
          appendToolCall(step.tool, step.args)
          appendToolResult(step.tool, step.result)
        }
      }
      if (!window._live.gotResponse && data.text) appendMessage('assistant', data.text)
    }
  } catch (err) {
    appendMessage('system', `请求失败: ${err.message}`)
  } finally {
    setLoading(false)
    hideThinking()
    await loadTasks() // 刷新任务列表的消息数
  }
}

// ── UI 工具 ───────────────────────────────────────────────

function appendMessage(role, content) {
  const div = document.createElement('div')
  div.className = `message ${role}`
  if (role === 'assistant') {
    const md = document.createElement('div')
    md.className = 'md-content'
    md.innerHTML = renderMarkdown(content)
    div.appendChild(md)
  } else {
    div.textContent = content
  }
  chatMessages.appendChild(div)
  chatMessages.scrollTop = chatMessages.scrollHeight
}

function appendImageToChat(dataUrl) {
  const div = document.createElement('div')
  div.className = 'message user-image'
  div.innerHTML = `
    <div class="user-image-container">
      <img src="${escapeHtml(dataUrl)}" alt="用户上传的图片">
      <div class="image-caption">📷 用户上传的图片</div>
    </div>
  `
  chatMessages.appendChild(div)
  chatMessages.scrollTop = chatMessages.scrollHeight
}

function appendToolCall(name, args) {
  const wrap = document.createElement('div')
  wrap.className = 'message tool-call'
  const argsStr = (args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length)
    ? formatToolValue(args)
    : '（无参数）'
  wrap.innerHTML = `
    <div class="tool-call-head">
      <span class="tool-icon">🔧</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-state calling">调用中…</span>
    </div>
    <div class="tool-args"><code>${escapeHtml(argsStr).slice(0, 400)}</code></div>`
  chatMessages.appendChild(wrap)
  chatMessages.scrollTop = chatMessages.scrollHeight
  addLogEntry(name, 'calling')
}

function appendToolResult(name, result) {
  const wrap = document.createElement('div')
  wrap.className = 'message tool-result'
  const display = formatToolValue(result)
  const parsed = typeof result === 'string' ? tryParseJSON(result) : result
  const isErr = !!(parsed && typeof parsed === 'object' && parsed.error) ||
                (typeof result === 'string' && (/"error"/.test(result) || result.startsWith('错误')))
  wrap.innerHTML = `
    <div class="tool-call-head">
      <span class="tool-icon">${isErr ? '⚠️' : '✅'}</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-state ${isErr ? 'error' : 'success'}">${isErr ? '失败' : '完成'}</span>
    </div>
    <div class="tool-args"><code>${escapeHtml(display).slice(0, 600)}</code></div>`
  chatMessages.appendChild(wrap)
  chatMessages.scrollTop = chatMessages.scrollHeight
  addLogEntry(name, isErr ? 'error' : 'success')
}

function addLogEntry(name, status) {
  if (executionLog.querySelector('.log-empty')) executionLog.innerHTML = ''
  const div = document.createElement('div')
  div.className = 'log-entry'
  div.innerHTML = `<span class="tool-name">${escapeHtml(name)}</span><span class="tool-status ${status === 'success' ? 'success' : ''}">${status === 'success' ? '✓' : '...'}</span>`
  executionLog.appendChild(div)
  executionLog.scrollTop = executionLog.scrollHeight
}

function setLoading(loading) {
  isLoading = loading
  btnSend.disabled = loading
  chatInput.disabled = loading
  statusIndicator.className = `status-dot ${loading ? 'thinking' : 'idle'}`
  statusText.textContent = loading ? '思考中...' : '就绪'
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── 工具结果/参数：把"原始 JSON"转为可读正常数据（界面不再出现 JSON 大括号） ──
// 尝试把字符串解析成对象/数组；解析失败（或本就不是 JSON）返回 undefined
function tryParseJSON(str) {
  if (typeof str !== 'string') return undefined
  const s = str.trim()
  if (s !== '' && (s[0] === '{' || s[0] === '[')) {
    try { return JSON.parse(s) } catch { return undefined }
  }
  return undefined
}

// 字段名人类可读化：snake_case / camelCase → 空格分词并首字母大写
function humanizeKey(k) {
  return String(k)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase())
}

// 单值展示（基本类型直接出，嵌套对象/数组递归，不再丢 JSON 大括号）
function formatScalar(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.length ? v.map(formatScalar).join('、') : '（空）'
  if (typeof v === 'object') return formatObject(v)
  return String(v)
}

// 对象展示：错误优先；读类工具直接出正文；其余剔除状态字段后做"标签：值"逐行展示
function formatObject(obj) {
  if (obj == null) return '—'
  if (typeof obj.error === 'string') {
    let s = '❌ 错误：' + obj.error
    if (obj.code) s += `（${obj.code}）`
    return s
  }
  if (typeof obj.content === 'string' && obj.content.trim()) return obj.content
  const skip = new Set(['success', 'isError', 'error'])
  const keys = Object.keys(obj).filter(k => !skip.has(k))
  if (keys.length === 0) return obj.success === false ? '（失败）' : '✅ 成功'
  return keys.map(k => `${humanizeKey(k)}：${formatScalar(obj[k])}`).join('\n')
}

function formatAny(v) {
  if (v == null) return '（无返回）'
  if (Array.isArray(v)) {
    if (!v.length) return '（空列表）'
    return v.map(it => `· ${formatScalar(it)}`).join('\n')
  }
  if (typeof v === 'object') return formatObject(v)
  return formatScalar(v)
}

// 统一入口：字符串（可能是 JSON）与对象都可处理
function formatToolValue(v) {
  if (typeof v === 'string') {
    const parsed = tryParseJSON(v)
    if (parsed !== undefined) return formatAny(parsed)
    return v
  }
  return formatAny(v)
}

// ── Markdown 渲染（对话框格式美化，离线无依赖）─────────────

function isHashCommentLang(lang) {
  return /^(py|python|sh|bash|shell|zsh|yml|yaml|rb|ruby|toml|ini|cfg|conf|dockerfile|make|makefile|gradle|r|jl|julia|pl|perl|php|sql)$/i.test(lang || '')
}

// 轻量语法高亮：注释 / 字符串 / 数字 / 关键字。先整体转义，按匹配片段包裹 span，避免嵌套出错。
function highlightCode(raw, lang) {
  const KEYWORDS = new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'class', 'def', 'import', 'from', 'include', 'int', 'void', 'public', 'private', 'protected', 'struct', 'enum', 'true', 'false', 'null', 'None', 'True', 'False', 'new', 'async', 'await', 'export', 'default', 'try', 'catch', 'throw', 'elif', 'then', 'fi', 'echo', 'print', 'printf', 'using', 'namespace', 'std', 'auto', 'static', 'break', 'continue', 'switch', 'case', 'func', 'val', 'interface', 'type', 'package', 'fn'])
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|<!--[\s\S]*?-->)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)/g
  let out = ''
  let last = 0
  let m
  while ((m = re.exec(raw)) !== null) {
    out += escapeHtml(raw.slice(last, m.index))
    const text = m[0]
    if (m[1]) {
      if (text[0] === '#' && !isHashCommentLang(lang)) out += escapeHtml(text)
      else out += `<span class="tok-comment">${escapeHtml(text)}</span>`
    } else if (m[2]) {
      out += `<span class="tok-string">${escapeHtml(text)}</span>`
    } else if (m[3]) {
      out += `<span class="tok-num">${escapeHtml(text)}</span>`
    } else if (m[4]) {
      out += KEYWORDS.has(text) ? `<span class="tok-key">${escapeHtml(text)}</span>` : escapeHtml(text)
    }
    last = re.lastIndex
  }
  out += escapeHtml(raw.slice(last))
  return out
}

function renderCodeBlock(code, lang) {
  const langLabel = (lang || 'text').toLowerCase()
  return `<div class="code-block">
    <div class="code-head"><span class="code-lang">${escapeHtml(langLabel)}</span><button class="code-copy" type="button">复制</button></div>
    <pre><code class="language-${escapeHtml(langLabel)}">${highlightCode(code, langLabel)}</code></pre>
  </div>`
}

function inlineMd(text) {
  // 整段若是被单个反引号包裹的多行代码 → 直接作为代码块（带复制按钮），避免被当行内代码压成一行
  const whole = text.match(/^\s*`([\s\S]+?)`\s*$/)
  if (whole && whole[1].includes('\n')) {
    return renderCodeBlock(whole[1].trim(), detectLang(whole[1]))
  }
  let s = escapeHtml(text)
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code class="inline">${c}</code>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/_([^_\n]+)_/g, '<em>$1</em>')
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`)
  return s
}

// 粗略判断一段纯文本是否像源代码（用于把模型"裸输出"的代码也渲染成代码块）
function looksLikeCode(text) {
  const lines = text.split('\n')
  if (lines.length < 3) {
    // 单行/双行且以强代码特征开头（#include/import/def/class/...）→ 也视为代码块，避免裸奔
    if (/^(#include|import\s|from\s|using\s|package\s|#!\/|def\s|class\s|public\s|private\s|protected\s|function\s|const\s|let\s|var\s|interface\s|enum\s|struct\s)/.test(text.trim())) return true
    return false
  }
  // 含中文句子标点 → 视为正文，不当代码
  if (/[。，！？、；：「」（）]/.test(text)) return false
  const marker = /(#include|import\s|from\s|def\s|class\s|function\s|public\s|private\s|protected\s|void\s|int\s|const\s|let\s|var\s|return\s|=>|std::|console\.log|print\(|\bfn\s|package\s|using\s|namespace\s|;\s*$|\{\s*$|\}\s*$)/i
  let hits = 0
  for (const l of lines) if (marker.test(l)) hits++
  return hits >= 2
}

// 根据代码特征推测语言（仅用于代码块角标，缺失则用 text）
function detectLang(text) {
  if (/#include|std::|int\s+main|cout|printf|std::endl/.test(text)) return 'cpp'
  if (/\bdef\s|print\(|import\s+os\b|\bself\b|elif\s/.test(text)) return 'python'
  if (/\bfunction\b|=>|console\.|const\s|let\s|var\s|document\./.test(text)) return 'javascript'
  if (/\bpublic\s+class|System\.out|void\s+main/.test(text)) return 'java'
  if (/#!\/|echo\s|sudo\s|\$\s|apt\b|yum\b/.test(text)) return 'bash'
  if (/package\s+main|func\s+main|fmt\.|\bgo\b/.test(text)) return 'go'
  if (/<\?php|<\?xml/.test(text)) return 'php'
  return 'text'
}

function renderMarkdown(src) {
  if (!src) return ''
  // 还原模型可能直接吐出的 HTML 换行标签（agnes 等聊天模型常用 <br> 当换行），
  // 否则 escapeHtml 后会被原样显示成文字。同时兼容已被转义的 &lt;br&gt;。
  const normalized = String(src)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/br>/gi, '\n')
    .replace(/&lt;br\s*\/?&gt;/gi, '\n')
    .replace(/&lt;\/br&gt;/gi, '\n')
  const lines = normalized.replace(/\r\n/g, '\n').split('\n')
  let html = ''
  let inList = null
  let i = 0
  const closeList = () => { if (inList) { html += `</${inList}>`; inList = null } }
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      closeList()
      const lang = fence[1] || ''
      const buf = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++
      html += renderCodeBlock(buf.join('\n'), lang)
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) { closeList(); const l = h[1].length; html += `<h${l}>${inlineMd(h[2])}</h${l}>`; i++; continue }
    if (/^>\s?/.test(line)) {
      closeList()
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++ }
      html += `<blockquote>${inlineMd(buf.join(' '))}</blockquote>`
      continue
    }
    const ul = line.match(/^[-*]\s+(.*)$/)
    if (ul) { if (inList !== 'ul') { closeList(); html += '<ul>'; inList = 'ul' } html += `<li>${inlineMd(ul[1])}</li>`; i++; continue }
    const ol = line.match(/^\d+\.\s+(.*)$/)
    if (ol) { if (inList !== 'ol') { closeList(); html += '<ol>'; inList = 'ol' } html += `<li>${inlineMd(ol[1])}</li>`; i++; continue }
    if (line.trim() === '') { closeList(); i++; continue }
    closeList()
    const STOP = /^(```|#{1,4}\s|>\s?|[-*]\s|\d+\.\s)/
    const buf = [line]; i++
    while (i < lines.length && lines[i].trim() !== '' && !STOP.test(lines[i])) { buf.push(lines[i]); i++ }
    let para = buf.join('\n')
    // 裸多行代码（模型未用围栏）自动渲染为代码块 + 复制按钮；其余按普通段落
    if (looksLikeCode(para)) {
      // 合并被空行隔开的相邻代码块（如 #include 单独成行），避免一段代码被拆成多个块
      while (i < lines.length) {
        let j = i
        while (j < lines.length && lines[j].trim() === '') j++ // 跳过空行
        if (j >= lines.length || STOP.test(lines[j])) break
        const nbuf = []
        let k = j
        while (k < lines.length && lines[k].trim() !== '' && !STOP.test(lines[k])) { nbuf.push(lines[k]); k++ }
        if (!looksLikeCode(nbuf.join('\n'))) break
        para += '\n' + nbuf.join('\n')
        i = k
      }
      let code = para.trim()
      // 模型偶尔用跨行反引号整体包裹代码，剥掉首尾反引号
      if (code.startsWith('`') && code.endsWith('`')) code = code.slice(1, -1)
      html += renderCodeBlock(code, detectLang(code))
    } else {
      html += `<p>${inlineMd(para)}</p>`
    }
  }
  closeList()
  return html
}

// ── 图像分析集成到对话 ─────────────────────────────────────

let _chatImageDataUrl = null   // 当前对话中的图片数据（一次一张，走视觉分析）
let _chatFileAttach = []       // 文本类附件 [{name, content}]，发送时内联进消息

const TEXT_EXT_RE = /\.(txt|md|markdown|json|csv|log|xml|yml|yaml|js|ts|py|java|c|cpp|h|css|html|ini|conf|sql)$/i
const MAX_FILE_CHARS = 100000  // 单个附件注入消息的字符上限

function isImageFile(f) { return f.type && f.type.startsWith('image/') }
function isTextFile(f) { return (f.type && f.type.startsWith('text/')) || TEXT_EXT_RE.test(f.name) }

// 统一入口：处理「+ 号选择」或「拖入」的文件列表
function handlePickedFiles(files) {
  for (const f of files) {
    if (isImageFile(f)) {
      if (_chatImageDataUrl) { alert('一次只支持一张图片，已保留先选的那张'); continue }
      const reader = new FileReader()
      reader.onload = () => { _chatImageDataUrl = reader.result; renderAttachChips() }
      reader.readAsDataURL(f)
    } else if (isTextFile(f)) {
      if (_chatFileAttach.length >= 5) { alert('附件最多 5 个'); continue }
      const reader = new FileReader()
      reader.onload = () => {
        _chatFileAttach.push({ name: f.name, content: String(reader.result).slice(0, MAX_FILE_CHARS) })
        renderAttachChips()
      }
      reader.readAsText(f)
    } else {
      alert(`暂不支持该文件类型：${f.name}（支持图片与文本类文件）`)
    }
  }
}

// 输入框上方的附件芯片（图片缩略图 / 文件名），✕ 可单独移除
function renderAttachChips() {
  const box = document.getElementById('attachChips')
  if (!box) return
  const parts = []
  if (_chatImageDataUrl) {
    parts.push(`<div class="chip chip-image"><img src="${_chatImageDataUrl}" alt="图片">` +
      `<button class="chip-x" onclick="removeChatImage()">✕</button></div>`)
  }
  for (let i = 0; i < _chatFileAttach.length; i++) {
    parts.push(`<div class="chip chip-file"><span class="chip-name">📄 ${escapeHtml(_chatFileAttach[i].name)}</span>` +
      `<button class="chip-x" onclick="removeFileAttach(${i})">✕</button></div>`)
  }
  box.innerHTML = parts.join('')
  box.classList.toggle('hidden', parts.length === 0)
}

function removeFileAttach(i) {
  _chatFileAttach.splice(i, 1)
  renderAttachChips()
}

function removeChatImage() {
  _chatImageDataUrl = null
  renderAttachChips()
}

function setupImageUpload() {
  // 「+」按钮 → 打开文件选择（图片 + 文本类文件）
  const plusBtn = document.getElementById('btnPlus')
  const fileInput = document.getElementById('chatFileInput')
  if (plusBtn && fileInput) {
    plusBtn.addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || [])
      if (files.length) handlePickedFiles(files)
      fileInput.value = ''
    })
  }
  // 拖拽保留：直接拖到整个输入区即可，不再占独立版面
  const shell = document.querySelector('.chat-input-area')
  if (shell) {
    shell.addEventListener('dragover', (e) => { e.preventDefault(); shell.classList.add('drag-over') })
    shell.addEventListener('dragleave', () => shell.classList.remove('drag-over'))
    shell.addEventListener('drop', (e) => {
      e.preventDefault()
      shell.classList.remove('drag-over')
      const files = Array.from(e.dataTransfer.files || [])
      if (files.length) handlePickedFiles(files)
    })
  }
}

// ── 事件监听 ──────────────────────────────────────────────

function setupEventListeners() {
  btnSend.addEventListener('click', sendMessage)
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  })
  
  setupImageUpload()

  btnReset.addEventListener('click', async () => {
    if (!currentTaskId) return
    await fetch(`${API}/api/reset`, { method: 'POST' })
    renderChatWelcome()
    executionLog.innerHTML = '<div class="log-empty">暂无执行记录</div>'
    await loadTasks()
  })

  $('#btnRename').addEventListener('click', () => {
    if (currentTaskId) {
      // 从任务列表中找标题
      const item = document.querySelector('.task-item.active .task-item-title')
      renameTask(currentTaskId, item ? item.textContent.replace(/^● /, '') : '')
    }
  })

  // 工作区选择（新建项目弹窗）：新建文件夹 / 选择本地文件夹
  setupWorkspacePicker()

  // 技能包（zip）一键安装：点击按钮触发文件选择，选中后上传
  const btnInstallSkill = document.getElementById('btnInstallSkill')
  const skillZipInput = document.getElementById('skillZipInput')
  if (btnInstallSkill && skillZipInput) {
    btnInstallSkill.addEventListener('click', () => skillZipInput.click())
    skillZipInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0]
      if (f) installSkillFromZipFile(f)
      e.target.value = '' // 允许重复选同一文件
    })
  }

  // Esc 关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'))
    }
  })

  // 对话区点击代理：代码块复制 + 思考过程折叠
  chatMessages.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.code-copy')
    if (copyBtn) {
      const code = copyBtn.closest('.code-block')?.querySelector('code')
      if (code) {
        const text = code.textContent
        const done = () => { const o = copyBtn.textContent; copyBtn.textContent = '已复制'; setTimeout(() => (copyBtn.textContent = o), 1200) }
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done))
        else fallbackCopy(text, done)
      }
      return
    }
    const head = e.target.closest('.ts-head')
    if (head) head.closest('.thinking-stream')?.classList.toggle('collapsed')
  })

  // 点击遮罩关闭
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.add('hidden')
    })
  })

  // 图片上传功能已在 setupImageUpload 中处理
}

// ── WebSocket ─────────────────────────────────────────────

// ── 实时流辅助 ──────────────────────────────────────────

function showThinking(text) {
  const pill = $('#thinkingPill')
  if (pill) { pill.textContent = text || '● 执行中…'; pill.classList.remove('hidden') }
}

function hideThinking() {
  const pill = $('#thinkingPill')
  if (pill) pill.classList.add('hidden')
}

// ── 流式"思考过程"气泡（与结果分离，可折叠）─────────────

function createThinkBubble() {
  const wrap = document.createElement('div')
  wrap.className = 'message thinking-stream'
  wrap.innerHTML = `
    <div class="ts-head"><span class="chev">▾</span><span class="ts-label">💭 思考过程</span></div>
    <div class="ts-body"><span class="ts-text"></span><span class="ts-cursor">▋</span></div>`
  chatMessages.appendChild(wrap)
  chatMessages.scrollTop = chatMessages.scrollHeight
  return wrap
}

// 增量追加 token（首个非空 delta 才创建气泡，纯工具调用轮不留空气泡）
function appendThinkToken(delta) {
  if (!_thinkBubble) _thinkBubble = createThinkBubble()
  window._lastThinkBubble = _thinkBubble
  const t = _thinkBubble.querySelector('.ts-text')
  t.textContent += delta
  chatMessages.scrollTop = chatMessages.scrollHeight
}

function endThinkBubble() {
  if (_thinkBubble) {
    const c = _thinkBubble.querySelector('.ts-cursor')
    if (c) c.remove()
    _thinkBubble.classList.add('ended')
    _thinkBubble = null
  }
}

// 定稿：去掉打字光标，标记为正式思考记录并自动折叠（避免与结果重复刷屏）
function finalizeThinkBubble(el) {
  if (!el) return
  el.classList.add('final', 'collapsed')
  const c = el.querySelector('.ts-cursor')
  if (c) c.remove()
  const label = el.querySelector('.ts-label')
  if (label) label.textContent = '💭 思考过程（生成轨迹）'
}

function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
    done()
  } catch { /* ignore */ }
}

function updateTokenStat(data) {
  if (tokenStat) {
    tokenStat.textContent = `本次 ${(data.totalK ?? 0).toFixed(2)}K · ${data.tps ?? 0} t/s`
  }
}

function resetTokenStat() {
  if (tokenStat) tokenStat.textContent = '0.00K · 0 t/s'
  window._thinkHadBubble = false
  window._lastThinkBubble = null
  _thinkBubble = null
}

function renderPlan(text) {
  const section = $('#planSection')
  const box = $('#planBox')
  if (!section || !box) return
  box.innerHTML = escapeHtml(text || '').replace(/\n/g, '<br>')
  section.classList.remove('hidden')
}

function hidePlan() {
  const section = $('#planSection')
  if (section) section.classList.add('hidden')
}

function renderSafety(reason) {
  addLogEntry('安全拦截', 'error')
  const wrap = document.createElement('div')
  wrap.className = 'message safety-banner'
  wrap.innerHTML = `<span class="shield">🛡️</span><div><div class="safety-title">安全拦截</div><div class="safety-reason">${escapeHtml(reason || '')}</div></div>`
  chatMessages.appendChild(wrap)
  chatMessages.scrollTop = chatMessages.scrollHeight
}

function updateState(state) {
  let cls = 'idle', txt = '就绪'
  if (state === 'thinking') { cls = 'thinking'; txt = '思考中…' }
  else if (state === 'tool_call') { cls = 'thinking'; txt = '调用工具…' }
  else if (state === 'tool_result') { cls = 'thinking'; txt = '工具返回…' }
  else if (state === 'responding') { cls = 'thinking'; txt = '回复中…' }
  else if (state === 'error') { cls = 'error'; txt = '错误' }
  statusIndicator.className = `status-dot ${cls}`
  statusText.textContent = txt
}

// ── WebSocket ─────────────────────────────────────────────

function setupWebSocket() {
  const ws = new WebSocket(`ws://${location.host}`)
  ws.onmessage = (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    const { event, data } = msg
    switch (event) {
      case 'state':
        updateState(data.state); break
      case 'planning':
        showThinking('🧠 规划任务中…'); break
      case 'step':
        showThinking(`● 第 ${data.step} 步`)
        addLogEntry(`第 ${data.step} 步`, 'calling')
        break
      case 'tool_call':
        window._live = window._live || {}
        window._live.gotTool = true
        appendToolCall(data.name, data.arguments); break
      case 'tool_result':
        window._live = window._live || {}
        window._live.gotTool = true
        appendToolResult(data.name, data.result); break
      case 'response':
        window._live = window._live || {}
        window._live.gotResponse = true
        // thinking 与结果分离：定稿思考气泡（自动折叠），结果以独立 markdown 气泡呈现
        if (window._thinkHadBubble && window._lastThinkBubble) {
          finalizeThinkBubble(window._lastThinkBubble)
          window._thinkHadBubble = false
          window._lastThinkBubble = null
        }
        appendMessage('assistant', data.text)
        hideThinking(); break
      case 'token_start':
        window._thinkHadBubble = true; break
      case 'token':
        if (data.delta) appendThinkToken(data.delta); break
      case 'token_end':
        endThinkBubble(); break
      case 'usage':
        updateTokenStat(data); break
      case 'usage_reset':
        resetTokenStat(); break
      case 'plan':
        renderPlan(data.text); break
      case 'safety':
        renderSafety(data.reason); break
      case 'parse_error':
        addLogEntry('格式解析错误', 'error'); break
      default:
        break
    }
  }
  ws.onclose = () => setTimeout(setupWebSocket, 3000)
}

// ── 图片上传提示 ──────────────────────────────────────────

function showImageUploadHint() {
  $('#imageUploadHint').classList.remove('hidden')
}

// ── 全局导出 ──────────────────────────────────────────────

// ── 全局导出 ──────────────────────────────────────────────

window.closeModal = closeModal
window.closeModelsModal = closeModelsModal
window.openSkillsModal = openSkillsModal
window.openMcpModal = openMcpModal
window.openProjectsModal = async () => {
  $('#projectsModal').classList.remove('hidden')
  await loadProjectsList()
}
window.onMcpTypeChange = onMcpTypeChange
window.addMcpServer = addMcpServer
window.connectMcp = connectMcp
window.connectAllMcp = connectAllMcp
window.disconnectMcp = disconnectMcp
window.deleteMcpServer = deleteMcpServer
window.createProject = createProject
window.selectProject = selectProject
window.deleteProject = deleteProject
window.createNewTask = createNewTask
window.confirmCreateTask = confirmCreateTask
window.switchTask = switchTask
window.renameTask = renameTask
window.deleteTask = deleteTask
window.activateSkill = activateSkill
window.deactivateSkill = deactivateSkill
window.createCustomSkill = createCustomSkill
window.deleteSkill = deleteSkill
window.onProviderChange = onProviderChange
window.saveModel = saveModel
window.testModel = testModel
window.fetchModels = fetchModels
window.onModelSelect = onModelSelect
window.resetForm = resetForm
window.editModel = editModel
window.deleteModel = deleteModel
window.activateModel = activateModel
window.showImageUploadHint = showImageUploadHint

init()
