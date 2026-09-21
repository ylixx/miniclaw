/**
 * Safety Gate - 全局 deny-first 安全闸（借鉴 localharness）
 *
 * 设计原则（deny-first）：
 * 1. 危险命令黑名单：即便 MCP 服务器被 operator 显式 trustCommand，
 *    命中黑名单的命令/参数也一律拒绝（黑名单不可被信任放宽）。
 * 2. 受保护路径：禁止对 .git / agent 配置目录等做删除/覆写/移动，
 *    防止 agent 自毁工作区或泄露配置。
 *
 * 返回 null 表示通过；返回字符串表示拒绝原因。
 */

import path from 'path'

// 危险命令/参数模式（命令执行类，适用于 MCP stdio 命令与未来的 shell 工具）
const DENY_COMMAND_PATTERNS = [
  /\bcurl\b[^]*\|\s*(?:sh|bash)\b/i,          // curl ... | sh
  /\bwget\b[^]*\|\s*(?:sh|bash)\b/i,          // wget ... | sh
  /\|\s*(?:sh|bash)\b/i,                       // 任意命令管道到 shell（| sh / | bash）
  /\bdd\b\s+[^]*\bof=/i,                       // dd 写设备
  /\bmkfs\b/i,                                 // 格式化
  /\bshred\b/i,                                //  shred 擦除
  /\bsudo\b/i,                                 // 提权
  /\bsu\b\s+-/i,                               // 切换用户
  /\bgit\s+push\b[^]*--force/i,                // git push --force
  /\bgit\s+reset\b[^]*--hard/i,                // git reset --hard
  /\bgit\s+clean\b[^]*-f/i,                    // git clean -f
  /\bchmod\b[^]*-R\b/i,                        // chmod -R
  /\bchown\b[^]*-R\b/i,                        // chown -R
  /:\s*\(\)\s*\{[^]*;\s*;\s*\}/i,             // fork bomb :(){ :|:& };:
  /\brm\b[^]*-rf\b[^]*\//i,                    // rm -rf /（根/绝对路径递归删）
]

// 工作区内受保护目录片段（命中即拒绝破坏性操作）
const PROTECTED_FRAGMENTS = ['.git', '.miniagent']

// 权限模式（借鉴 localharness 的 guarded / unattended 思路，为无人值守铺路）
//  - guarded：默认。写/删类危险操作需二次确认；deny-first 黑名单与受保护路径始终生效。
//  - read-only：禁止一切写/删类工具执行（用于只读审计 / 演示场景）。
//  - unattended：无人值守模式。跳过 delete_file 等二次确认，但仍受 deny-first 黑名单与受保护路径约束。
export const PERMISSION_MODES = ['guarded', 'read-only', 'unattended']

// 受 read-only 模式管控的「写 / 删」类工具（覆盖内置文件工具与常见 shell 工具名）
const MUTATING_TOOLS = new Set([
  'write_file', 'append_file', 'delete_file', 'move_file', 'copy_file',
  'create_dir', 'create_file', 'shell_exec', 'run_command', 'exec',
])

function defaultConfigDir() {
  return process.env.CONFIG_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', '.miniagent')
}

/**
 * 检查一条命令行字符串是否命中危险模式
 * @param {string} cli 命令 + 参数拼接后的字符串
 * @returns {string|null} 拒绝原因或 null
 */
export function checkCommandLine(cli) {
  if (!cli || typeof cli !== 'string') return null
  for (const re of DENY_COMMAND_PATTERNS) {
    if (re.test(cli)) return `命中危险命令模式（${re.source}）`
  }
  return null
}

/**
 * 检查路径是否命中受保护片段（.git / 配置目录等）
 * @returns {string|null} 拒绝原因或 null
 */
export function isProtectedPath(p, _baseDir, configDir) {
  if (!p || typeof p !== 'string') return null
  const norm = p.replace(/\\/g, '/')
  for (const frag of PROTECTED_FRAGMENTS) {
    if (norm.split('/').includes(frag)) return `受保护目录片段 "${frag}"`
  }
  const cfg = (configDir || defaultConfigDir()).replace(/\\/g, '/').replace(/\/$/, '')
  if (cfg && (norm === cfg || norm.startsWith(cfg + '/'))) {
    return 'agent 配置目录'
  }
  return null
}

/**
 * 对一次工具调用做 deny-first 检查（文件类工具专用）
 * @param {string} name 工具名
 * @param {object} args 参数
 * @returns {string|null} 拒绝原因或 null
 */
export function checkFileOp(name, args = {}, configDir) {
  const fileTools = new Set(['delete_file', 'write_file', 'append_file', 'move_file', 'copy_file'])
  if (!fileTools.has(name)) return null
  const candidates = []
  if (args.path) candidates.push(args.path)
  if (args.from) candidates.push(args.from)
  if (args.to) candidates.push(args.to)
  if (args.dir) candidates.push(args.dir)
  for (const c of candidates) {
    const reason = isProtectedPath(c, null, configDir)
    if (reason) return `禁止对${reason}执行「${name}」`
  }
  return null
}

/**
 * 权限模式检查（在工具执行前调用，覆盖内置工具与 MCP 工具）。
 * @param {string} mode 当前权限模式：guarded | read-only | unattended
 * @param {string} name 工具名
 * @returns {string|null} 拒绝原因或 null（放行）
 *
 * 注意：本函数只管控「写/删」类工具的开关，不替代 deny-first 黑名单
 * （checkCommandLine）与受保护路径（isProtectedPath / checkFileOp）——后者始终生效。
 */
export function checkPermissionMode(mode, name) {
  if (!mode || mode === 'guarded' || mode === 'unattended') return null
  if (mode === 'read-only' && MUTATING_TOOLS.has(name)) {
    return `当前为 read-only 模式，禁止执行写/删类工具「${name}」`
  }
  return null
}

/**
 * 是否处于无人值守模式（跳过 delete_file 等二次确认）
 */
export function isUnattended(mode) {
  return mode === 'unattended'
}
