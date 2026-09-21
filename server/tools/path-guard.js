/**
 * Path Guard - 路径安全校验
 *
 * 所有文件工具必须经过这里解析路径，防止目录穿越攻击：
 * 1. 绝对路径只允许落在 baseDir 内（或显式 allowOutside）
 * 2. 相对路径以 baseDir 为根解析
 * 3. 解析后必须二次校验真实路径仍以 baseDir 为前缀（防 symlink/.. 拼接）
 * 4. 拒绝 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）
 */

import path from 'path'
import fs from 'fs/promises'

// Windows 保留设备名
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

export class PathGuardError extends Error {
  constructor(message, code = 'PATH_DENIED') {
    super(message)
    this.name = 'PathGuardError'
    this.code = code
  }
}

export class PathGuard {
  /**
   * @param {string} baseDir 允许访问的根目录（真实绝对路径）
   */
  constructor(baseDir) {
    this.baseDir = path.resolve(baseDir)
  }

  /**
   * 校验并解析一个路径（同步，字符串级 + 前缀校验，不做 fs 检查）
   * @param {string} userPath 用户/模型提供的路径
   * @returns {string} 安全的绝对路径
   * @throws PathGuardError
   */
  resolve(userPath) {
    if (typeof userPath !== 'string' || userPath.trim() === '') {
      throw new PathGuardError('路径不能为空')
    }

    let p = userPath.trim()

    // 拒绝保留设备名
    const base = path.basename(p).split(/[\\/]/).pop() || ''
    if (WIN_RESERVED.test(base)) {
      throw new PathGuardError(`不允许的保留设备名: ${base}`)
    }

    // 解析：相对路径以 baseDir 为根；path.resolve 已展开 .. 防字符串级穿越
    const resolved = path.resolve(this.baseDir, p)
    this._assertInside(resolved)
    return resolved
  }

  /**
   * 断言路径落在 baseDir 内（防字符串级目录穿越）
   */
  _assertInside(p) {
    const rel = path.relative(this.baseDir, p)
    if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
      throw new PathGuardError(
        `拒绝访问 ${p}：超出工作目录范围（${this.baseDir}）。请使用工作目录内的相对路径。`
      )
    }
  }

  /**
   * 解析并做文件系统校验（存在性/类型），并解析 symlink 真实路径做二次越界校验
   */
  async resolveChecked(userPath, { mustExist = true, allowDir = true, allowFile = true } = {}) {
    const resolved = this.resolve(userPath)

    if (!mustExist) {
      // 写目标可能尚不存在：解析父目录真实路径，再拼回文件名做二次越界校验
      const parent = path.dirname(resolved)
      try {
        const realParent = await fs.realpath(parent)
        this._assertInside(realParent)
        const candidate = path.join(realParent, path.basename(resolved))
        this._assertInside(candidate)
        return candidate
      } catch {
        // 父目录也不存在：无法 realpath，退化为字符串级前缀校验（resolve 已做）
        return resolved
      }
    }

    let stat
    try {
      stat = await fs.stat(resolved)
    } catch {
      throw new PathGuardError(`路径不存在: ${userPath}`, 'PATH_NOT_FOUND')
    }

    // 防 symlink 逃逸：取真实路径做二次越界校验
    let realPath
    try {
      realPath = await fs.realpath(resolved)
    } catch {
      realPath = resolved
    }
    this._assertInside(realPath)

    if (stat.isDirectory() && !allowDir) {
      throw new PathGuardError(`这是一个目录，不是文件: ${userPath}`)
    }
    if (stat.isFile() && !allowFile) {
      throw new PathGuardError(`这是一个文件，不是目录: ${userPath}`)
    }
    return realPath
  }
}
