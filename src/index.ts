import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { defineExtension, useCommand } from 'reactive-vscode'
import { ThemeIcon, window, workspace } from 'vscode'
import * as Meta from './generated/meta'

const execAsync = promisify(exec)

const DELETE_BUTTON = {
  iconPath: new ThemeIcon('trash'),
  tooltip: '删除分支',
}

interface BranchInfo {
  name: string
  current: boolean
  author: string
  date: string
  hash: string
  message: string
}

async function getBranches(cwd: string): Promise<BranchInfo[]> {
  // Use git for-each-ref to get rich info, sorted by committerdate descending
  const SEP = '\x1F'
  const fmt = [
    '%(refname:short)',
    '%(committerdate:relative)',
    '%(committername)',
    '%(objectname:short)',
    '%(subject)',
  ].join(SEP)

  const { stdout: refOut } = await execAsync(
    `git for-each-ref --sort=-committerdate refs/heads/ --format="${fmt}"`,
    { cwd },
  )

  // Detect current branch
  const { stdout: headOut } = await execAsync('git symbolic-ref --short HEAD', { cwd })
  const currentBranch = headOut.trim()

  return refOut
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, date, author, hash, ...rest] = line.split(SEP)
      return {
        name,
        current: name === currentBranch,
        author: author ?? '',
        date: date ?? '',
        hash: hash ?? '',
        message: rest.join(SEP) ?? '',
      }
    })
}

const { activate, deactivate } = defineExtension(() => {
  useCommand(Meta.commands.show, async () => {
    const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!cwd) {
      window.showErrorMessage('未找到工作区目录')
      return
    }

    let branches = await getBranches(cwd).catch((err: any) => {
      window.showErrorMessage(`获取分支列表失败: ${err.message}`)
      return null
    })
    if (!branches)
      return

    const qp = window.createQuickPick()
    qp.title = 'Quick Delete Branch'
    qp.placeholder = '勾选分支后点击 OK 批量删除，或点击条目右侧图标单独删除'
    qp.canSelectMany = true

    const buildItems = (list: BranchInfo[]) =>
      list.map(b => ({
        label: b.current ? `$(check) ${b.name}` : `$(git-branch) ${b.name}`,
        description: `${b.author}  $(git-commit) ${b.hash}  $(history) ${b.date}`,
        detail: b.message,
        buttons: b.current ? [] : [DELETE_BUTTON],
        // store branch name for lookup
        _name: b.name,
      }))

    qp.items = buildItems(branches)

    // Bulk delete via OK button
    qp.onDidAccept(async () => {
      type QpItem = ReturnType<typeof buildItems>[number]
      const selected = (qp.selectedItems as QpItem[]).filter((item) => {
        const branch = branches!.find(b => b.name === item._name)
        return branch && !branch.current
      })

      if (selected.length === 0) {
        window.showWarningMessage('请先勾选要删除的分支')
        return
      }

      const nameList = selected.map(i => `"${i._name}"`).join(', ')
      const answer = await window.showWarningMessage(
        `是否删除以下 ${selected.length} 个分支？\n${nameList}`,
        { modal: true },
        '确认',
      )
      if (answer !== '确认')
        return

      const failed: string[] = []
      for (const item of selected) {
        try {
          await execAsync(`git branch -d "${item._name}"`, { cwd })
          branches = branches!.filter(b => b.name !== item._name)
        }
        catch {
          failed.push(item._name)
        }
      }

      qp.items = buildItems(branches!)

      if (failed.length > 0) {
        window.showWarningMessage(
          `以下分支未完全合并，删除失败: ${failed.map(n => `"${n}"`).join(', ')}`,
        )
      }
      else {
        window.showInformationMessage(`已成功删除 ${selected.length} 个分支`)
      }
    })

    // Single delete via item button
    qp.onDidTriggerItemButton(async ({ item }) => {
      const branchItem = item as ReturnType<typeof buildItems>[number]
      const branchName = branchItem._name

      const answer = await window.showWarningMessage(
        `是否删除该分支？ "${branchName}"`,
        { modal: true },
        '确认',
      )
      if (answer !== '确认')
        return

      try {
        await execAsync(`git branch -d "${branchName}"`, { cwd })
        branches = branches!.filter(b => b.name !== branchName)
        qp.items = buildItems(branches)
        window.showInformationMessage(`分支 "${branchName}" 已删除`)
      }
      catch {
        const force = await window.showWarningMessage(
          `分支 "${branchName}" 未完全合并，是否强制删除？`,
          { modal: true },
          '强制删除',
        )
        if (force !== '强制删除')
          return
        try {
          await execAsync(`git branch -D "${branchName}"`, { cwd })
          branches = branches!.filter(b => b.name !== branchName)
          qp.items = buildItems(branches)
          window.showInformationMessage(`分支 "${branchName}" 已强制删除`)
        }
        catch (err2: any) {
          window.showErrorMessage(`删除失败: ${err2.message}`)
        }
      }
    })

    qp.show()
  })
})

export { activate, deactivate }
