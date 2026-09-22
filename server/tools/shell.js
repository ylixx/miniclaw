/**
 * Shell / Command Execution Tool - 命令执行工具（带 deny-first 安全闸）
 *
 * 让 agent 能在工作目录中执行 shell 命令（编译/运行程序、查看输出等），
 * 是 MiniAgent 缺失已久的执行能力（safety-gate 已预留 run_command / shell_exec / exec）。
 *
 * 安全保障（双重）：
 * 1. checkCommandLine：deny-first 危险命令黑名单（rm -rf /、curl|sh、sudo、dd of= 等）始终拒绝。
 * 2. checkPermissionMode：read-only 模式拦截一切执行类工具（与文件写/删同列于 MUTATING_TOOLS）。
 * 3. 工作目录锁定为 baseDir，不 chdir 到用户给的绝对路径，降低逃逸风险。
 * 4. 超时保护（默认 30s，最长 120s）+ 输出上限（8MB）。
 */

import { spawn } from 'child_process'
import { checkCommandLine, checkPermissionMode } from './safety-gate.js'

const DEFAULT_TIMEOUT = 30      // 秒
const MAX_TIMEOUT = 120         // 秒
const MAX_OUT = 8000            // 单段输出字符上限（返回给模型的截断长度）
const HARD_CAP = 8 * 1024 * 1024 // 异步累积输出字节硬上限，防大输出撑爆内存

export function registerShell(registry, { getBaseDir, getPermissionMode } = {}) {
  // 实时读取权限模式（与 file-ops 一致，支持模型切换后动态生效）
  const getMode = () => (getPermissionMode && getPermissionMode()) || 'guarded'  // guarded | read-only | unattended

  registry.register({
    name: 'run_command',
    description: '在工作目录中执行一条 shell 命令（如编译/运行程序、查看命令输出）。返回 stdout、stderr 与退出码。危险命令（rm -rf /、curl|sh、sudo、git reset --hard 等）会被安全闸拒绝。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的命令行。例如编译并运行 C++：g++ hello.cpp -o hello && hello；运行脚本：python app.py。Windows 上运行生成的可执行文件直接用程序名（如 hello），不要写 ./hello。',
        },
        timeout: { type: 'number', description: '超时秒数，默认 30，最长 120' },
      },
      required: ['command'],
    },
    async execute({ command, timeout }) {
      if (!command || typeof command !== 'string') {
        return { error: 'command 必须是非空字符串', code: 'VALIDATION' }
      }

      // 1) deny-first 危险命令黑名单
      const deny = checkCommandLine(command)
      if (deny) return { error: '安全拦截：' + deny, code: 'DENIED' }

      // 2) 权限模式闸（read-only 禁止执行）
      const perm = checkPermissionMode(getMode(), 'run_command')
      if (perm) return { error: '安全拦截：' + perm, code: 'DENIED' }

      const tSec = Math.max(1, Math.min(MAX_TIMEOUT, Number(timeout) || DEFAULT_TIMEOUT))

      // Windows 容错：模型常写 bash 风格 `./hello`（cmd 不认 `./` 前缀）。
      // 在词边界处把 `./name` 透明改写为 `name`（cmd 经 PATHEXT 会自动找 name.exe），
      // 且「编译后运行」整行（g++ ... && ./hello）也能开箱即用，无需先存在 .exe。
      // 仅在词边界改写，避免误伤 `../` 上级路径。
      let runCmd = command
      if (process.platform === 'win32') {
        const rewritten = command.replace(/(^|[\s&;|])\.\/([^\s&;|]+)/g, '$1$2')
        if (rewritten !== command) {
          console.log('[run_command] win 兼容改写:', command, '->', rewritten)
          runCmd = rewritten
        }
      }

      // ── 异步执行（关键：绝不能 spawnSync，否则冻结事件循环）──
      // 旧实现用 spawnSync 同步阻塞 Node 事件循环：当命令里 curl 本服务
      // (localhost:3000) 时，服务器自身事件循环被冻住无法响应，导致 curl
      // 必超时死锁（这也是此前 /health 全 ETIMEDOUT 的真因）。
      // 改用异步 spawn，事件循环始终空闲，自连本服的 curl 可正常往返。
      return new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        let timedOut = false
        let capHit = false

        const child = spawn(runCmd, [], {
          shell: true,            // Windows: cmd.exe /c <command>
          cwd: getBaseDir(),     // 锁定工作目录（当前激活项目 dir）
          windowsHide: true,
          env: { ...process.env },
        })
        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')

        const timer = setTimeout(() => {
          timedOut = true
          // Windows：杀掉进程树（/T 含子进程），避免残留
          try {
            spawn('taskkill', ['/PID', String(child.pid), '/F', '/T'], {
              windowsHide: true,
              detached: true,
              stdio: 'ignore',
            }).unref?.()
          } catch { /* ignore */ }
        }, tSec * 1000)

        const onData = (chunk, key) => {
          if (capHit) return
          if (stdout.length + stderr.length > HARD_CAP) { capHit = true; return }
          if (key === 'out') stdout += chunk
          else stderr += chunk
        }
        child.stdout?.on('data', (d) => onData(d, 'out'))
        child.stderr?.on('data', (d) => onData(d, 'err'))

        child.on('error', (err) => {
          clearTimeout(timer)
          resolve({
            error: `命令执行失败：${err.message}`,
            code: err.code || 'EXEC_ERROR',
            stdout: stdout.slice(0, MAX_OUT),
            stderr: stderr.slice(0, MAX_OUT),
          })
        })

        child.on('close', (code, signal) => {
          clearTimeout(timer)
          if (timedOut) {
            resolve({
              error: `命令执行超时（>${tSec}s）`,
              code: 'ETIMEDOUT',
              stdout: stdout.slice(0, MAX_OUT),
              stderr: stderr.slice(0, MAX_OUT),
            })
          } else {
            // 命令退出（exitCode 为 null 时多为被信号终止）
            resolve({
              stdout: stdout.slice(0, MAX_OUT),
              stderr: stderr.slice(0, MAX_OUT),
              exitCode: code ?? (signal ? `signal:${signal}` : -1),
            })
          }
        })
      })
    },
  })
}
