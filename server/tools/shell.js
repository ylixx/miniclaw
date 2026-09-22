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

import { spawnSync } from 'child_process'
import { checkCommandLine, checkPermissionMode } from './safety-gate.js'

const DEFAULT_TIMEOUT = 30      // 秒
const MAX_TIMEOUT = 120         // 秒
const MAX_OUT = 8000            // 单段输出字符上限

export function registerShell(registry, { baseDir, getPermissionMode } = {}) {
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

      const r = spawnSync(runCmd, [], {
        shell: true,            // Windows: cmd /c <command>
        cwd: baseDir,           // 锁定工作目录
        windowsHide: true,
        encoding: 'utf-8',
        timeout: tSec * 1000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env },
      })

      if (r.error) {
        const msg = r.error.code === 'ETIMEDOUT'
          ? `命令执行超时（>${tSec}s）`
          : `命令执行失败：${r.error.message}`
        return {
          error: msg,
          code: r.error.code || 'EXEC_ERROR',
          stdout: (r.stdout || '').slice(0, MAX_OUT),
          stderr: (r.stderr || '').slice(0, MAX_OUT),
        }
      }

      // 命令退出（exitCode 为 null 时多为被信号终止）
      return {
        stdout: (r.stdout || '').slice(0, MAX_OUT),
        stderr: (r.stderr || '').slice(0, MAX_OUT),
        exitCode: r.status ?? (r.signal ? `signal:${r.signal}` : -1),
      }
    },
  })
}
