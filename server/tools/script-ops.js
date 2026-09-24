/**
 * Script Execution Tool - 脚本执行工具
 *
 * 让 4B 小模型具备"写脚本完成复杂任务"的能力：
 * - 接收脚本内容 + 脚本文件名 + 执行命令
 * - 先用 write_file 写入工作区（受 PathGuard 保护）
 * - 再用 run_command 执行（受 deny-first 黑名单 + 权限模式闸保护）
 * - 返回执行结果（stdout/stderr/exitCode）
 *
 * 典型场景：
 * - 批量文件操作（批量重命名/移动/转换格式）
 * - 数据处理管道（cat + grep + awk + sort）
 * - 多步骤构建（cmake + make + install）
 * - 循环/条件逻辑（bash for/while/if，powershell foreach/if）
 *
 * 安全保障：
 * 1. 脚本文件名强制以 .sh/.bat/.ps1 结尾，防止任意扩展名
 * 2. 脚本文件名过 checkFileOp 受保护路径检查（.git / 配置目录），并经 PathGuard
 *    解析为工作区内绝对路径（防 ../ 目录穿越）后才写盘
 * 3. 脚本内容过 deny-first 黑名单（脚本体就是将要执行的命令，与 run_command 同级管控）
 * 4. 执行命令过 deny-first 黑名单 + 权限模式闸（read-only 拦截，run_script 在 MUTATING_TOOLS）
 * 5. 所有检查通过后才写脚本文件，执行完由 LLM 决定是否清理（不强制清理，避免误删）
 */

import { spawn } from 'child_process'
import path from 'path'
import { checkCommandLine, checkPermissionMode, checkFileOp } from './safety-gate.js'
import { PathGuard } from './path-guard.js'

const DEFAULT_TIMEOUT = 30      // 秒
const MAX_TIMEOUT = 120         // 秒
const MAX_OUT = 8000            // 单段输出字符上限（返回给模型的截断长度）
const HARD_CAP = 8 * 1024 * 1024 // 异步累积输出字节硬上限

export function registerScriptOps(registry, { getBaseDir, getPermissionMode } = {}) {
  const getMode = () => (getPermissionMode && getPermissionMode()) || 'guarded'

  registry.register({
    name: 'run_script',
    description: '写并执行一条 shell 脚本（支持多行逻辑、循环、条件判断等）。先在工作区写入脚本文件（文件名必须以 .sh/.bat/.ps1 结尾），然后执行脚本。返回 stdout/stderr/exitCode。适合批量操作、数据处理管道、多步骤构建等单命令无法完成的任务。',
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: '脚本内容。支持 bash (Linux/macOS)、batch (Windows)、powershell (Windows)。例如批量重命名：for f in *.txt; do mv "$f" "${f%.txt}.md"; done',
        },
        filename: {
          type: 'string',
          description: '脚本文件名，必须以 .sh/.bat/.ps1 结尾。例如 script.sh / script.bat / script.ps1',
        },
        command: {
          type: 'string',
          description: '执行命令。例如 bash script.sh、cmd /c script.bat、powershell -ExecutionPolicy Bypass -File script.ps1。若省略，根据文件扩展名自动推断：.sh → bash，.bat → cmd /c，.ps1 → powershell -ExecutionPolicy Bypass -File',
        },
        timeout: { type: 'number', description: '超时秒数，默认 30，最长 120' },
      },
      required: ['script', 'filename'],
    },
    async execute({ script, filename, command, timeout }) {
      // 1) 参数校验
      if (!script || typeof script !== 'string') {
        return { error: 'script 必须是非空字符串', code: 'VALIDATION' }
      }
      if (!filename || typeof filename !== 'string') {
        return { error: 'filename 必须是非空字符串', code: 'VALIDATION' }
      }

      // 扩展名白名单：不匹配直接拒绝（此前 || '.sh' 兜底会把 evil.exe 当成 .sh 放行）
      const ext = (filename.trim().toLowerCase().split(/[\\/]/).pop() || '').match(/\.(sh|bat|ps1)$/i)?.[0]
      const validExts = ['.sh', '.bat', '.ps1']
      if (!ext || !validExts.includes(ext)) {
        return { error: `文件扩展名必须是 ${validExts.join(' 或 ')}，当前为 ${path.basename(filename.trim()) || '(空)'}`, code: 'VALIDATION' }
      }

      // 2) 权限模式闸（read-only 禁止执行；run_script 已列入 MUTATING_TOOLS）
      const perm = checkPermissionMode(getMode(), 'run_script')
      if (perm) return { error: '安全拦截：' + perm, code: 'DENIED' }

      // 3) 脚本内容过 deny-first 黑名单：脚本体就是将要执行的命令，
      //    只检查执行命令行的话，任何被 run_command 拒绝的命令（curl|sh、sudo、dd...）
      //    写进脚本即可绕过，黑名单形同虚设。
      const denyScript = checkCommandLine(script)
      if (denyScript) return { error: '安全拦截（脚本内容）：' + denyScript, code: 'DENIED' }

      // 4) 受保护路径检查（.git / agent 配置目录等）+ PathGuard 解析写目标。
      //    此前用 `${baseDir}/${filename}` 裸拼接写文件：filename 含 ../ 即可穿越到
      //    工作区外任意位置写文件，且完全绕过 PathGuard 与 checkFileOp。
      const denyPath = checkFileOp('write_file', { path: filename })
      if (denyPath) return { error: '安全拦截：' + denyPath, needConfirm: true, code: 'DENIED' }

      const baseDir = getBaseDir()
      const guard = new PathGuard(baseDir)
      const scriptPath = await guard.resolveChecked(filename.trim(), { mustExist: false, allowDir: false })

      // 5) 确定执行命令（若未提供），并过黑名单
      let execCmd = command
      if (!execCmd) {
        switch (ext) {
          case '.sh':
            execCmd = `bash "${filename.trim()}"`
            break
          case '.bat':
            execCmd = `cmd /c "${filename.trim()}"`
            break
          case '.ps1':
            execCmd = `powershell -ExecutionPolicy Bypass -File "${filename.trim()}"`
            break
          default:
            return { error: `无法推断执行命令，请显式提供 command 参数，当前扩展名 ${ext}`, code: 'VALIDATION' }
        }
      }
      const deny = checkCommandLine(execCmd)
      if (deny) return { error: '安全拦截：' + deny, code: 'DENIED' }

      // 6) 全部检查通过后才落盘写脚本
      const fs = await import('fs')
      await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true })
      await fs.promises.writeFile(scriptPath, script, 'utf8')

      // 7) 执行脚本（deny-first 黑名单 + 超时保护）
      const tSec = Math.max(1, Math.min(MAX_TIMEOUT, Number(timeout) || DEFAULT_TIMEOUT))

      return new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        let timedOut = false
        let capHit = false

        const child = spawn(execCmd, [], {
          shell: true,
          cwd: baseDir,
          windowsHide: true,
          env: { ...process.env },
        })

        const timer = setTimeout(() => {
          timedOut = true
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
          const str = chunk.toString('utf8', 0, chunk.length > 1024 ? 1024 : chunk.length)
          if (key === 'out') stdout += str
          else stderr += str
        }
        child.stdout?.on('data', (d) => onData(d, 'out'))
        child.stderr?.on('data', (d) => onData(d, 'err'))

        child.on('error', (err) => {
          clearTimeout(timer)
          resolve({
            error: `脚本执行失败：${err.message}`,
            code: err.code || 'EXEC_ERROR',
            stdout: stdout.slice(0, MAX_OUT),
            stderr: stderr.slice(0, MAX_OUT),
          })
        })

        child.on('close', (code, signal) => {
          clearTimeout(timer)
          if (timedOut) {
            resolve({
              error: `脚本执行超时（>${tSec}s）`,
              code: 'ETIMEDOUT',
              stdout: stdout.slice(0, MAX_OUT),
              stderr: stderr.slice(0, MAX_OUT),
            })
          } else {
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
