import { useEffect, useState } from 'react'
import type {
  AddRuleInput,
  PermissionAction,
  PermissionRule,
  PermissionRuleEffect
} from '@shared/types'
import { useAppStore } from '../../state/store'

function basename(p: string): string {
  const parts = p.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || p
}

function scopeKey(rule: PermissionRule): string {
  return rule.scope === 'global' ? '' : rule.scope.projectPath
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Try again.'
}

// The permissions manager (Bb4, design section 6): lists user rules with
// delete, an add-rule form, and the builtin denies with a warned disable
// toggle. Rules minted by the approval card's allow-grid (ToolStep.tsx) land
// in the same table. Deletes and toggles take effect on the next evaluation:
// main reads rules and settings live per gate call.
export function PermissionRulesSection(): React.JSX.Element {
  const rules = useAppStore((s) => s.permissionRules)
  const refresh = useAppStore((s) => s.refreshPermissionRules)
  const addRule = useAppStore((s) => s.addPermissionRule)
  const deleteRule = useAppStore((s) => s.deletePermissionRule)
  const setBuiltinDisabled = useAppStore((s) => s.setBuiltinDisabled)
  const conversations = useAppStore((s) => s.conversations)
  const workspacePath = useAppStore((s) => s.workspacePath)

  const [action, setAction] = useState<PermissionAction>('command')
  const [effect, setEffect] = useState<PermissionRuleEffect>('allow')
  const [match, setMatch] = useState('')
  const [scope, setScope] = useState('') // '' = global, else a projectPath

  const [rulesError, setRulesError] = useState<string | null>(null)
  const [builtinsError, setBuiltinsError] = useState<string | null>(null)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const projectPaths: string[] = []
  for (const convo of Object.values(conversations)) {
    if (convo.projectPath && !projectPaths.includes(convo.projectPath)) {
      projectPaths.push(convo.projectPath)
    }
  }
  if (workspacePath && !projectPaths.includes(workspacePath)) projectPaths.push(workspacePath)
  projectPaths.sort()

  const groups = new Map<string, PermissionRule[]>()
  for (const rule of rules?.userRules ?? []) {
    const key = scopeKey(rule)
    const list = groups.get(key)
    if (list) list.push(rule)
    else groups.set(key, [rule])
  }
  const groupKeys = [...groups.keys()].sort((a, b) =>
    a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)
  )

  const submit = (): void => {
    const trimmed = match.trim()
    if (!trimmed) return
    const input: AddRuleInput = {
      scope: scope === '' ? 'global' : { projectPath: scope },
      action,
      match: trimmed,
      effect
    }
    addRule(input)
    setMatch('')
  }

  const runDelete = (rule: PermissionRule): void => {
    setRulesError(null)
    deleteRule(rule.id).catch((err) => setRulesError(describeError(err)))
  }

  const runSetBuiltinDisabled = (rule: PermissionRule, disabled: boolean): void => {
    setBuiltinsError(null)
    setBuiltinDisabled(rule.id, disabled).catch((err) => setBuiltinsError(describeError(err)))
  }

  const confirmDisable = (rule: PermissionRule): void => {
    const what = rule.action === 'command' ? 'commands' : 'file edits'
    const ok = window.confirm(
      `Disable this built-in protection?\n\n"${rule.match}" blocks a known dangerous pattern in every mode, including Auto. If you turn it off, BearCode will no longer block ${what} that match it.\n\nYou can re-enable it here with one click.`
    )
    if (ok) runSetBuiltinDisabled(rule, true)
  }

  return (
    <>
      <div className="set-group-title">Permission Rules</div>
      <div className="set-card">
        {groupKeys.length === 0 ? (
          <div className="rule-empty">
            No rules yet. Rules you save from approval cards appear here.
          </div>
        ) : (
          groupKeys.map((key) => (
            <div key={key === '' ? 'global' : key}>
              <div className="rule-scope-head" title={key === '' ? undefined : key}>
                {key === '' ? 'Everywhere' : basename(key)}
              </div>
              {(groups.get(key) ?? []).map((rule) => (
                <div className="rule-row" key={rule.id}>
                  <span className={'rule-badge ' + rule.effect}>{rule.effect}</span>
                  <span className="rule-action">{rule.action}</span>
                  <span className="rule-match">{rule.match}</span>
                  <button className="small-btn" onClick={() => runDelete(rule)}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
        {rulesError ? <div className="rule-error">{rulesError}</div> : null}
      </div>

      <div className="set-group-title">Add Rule</div>
      <div className="set-card pad">
        <div className="rule-form">
          <select
            value={action}
            onChange={(e) => setAction(e.target.value as PermissionAction)}
            title="What the rule gates"
          >
            <option value="command">Command</option>
            <option value="edit">Edit</option>
          </select>
          <select
            value={effect}
            onChange={(e) => setEffect(e.target.value as PermissionRuleEffect)}
            title="What happens on a match"
          >
            <option value="allow">Allow</option>
            <option value="deny">Deny</option>
            <option value="ask">Ask</option>
          </select>
          <input
            value={match}
            placeholder={action === 'command' ? 'e.g. git *' : 'e.g. .env.*'}
            onChange={(e) => setMatch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
          <select value={scope} onChange={(e) => setScope(e.target.value)} title="Where it applies">
            <option value="">Everywhere</option>
            {projectPaths.map((p) => (
              <option key={p} value={p} title={p}>
                {basename(p)}
              </option>
            ))}
          </select>
          <button className="small-btn" disabled={!match.trim()} onClick={submit}>
            Add
          </button>
        </div>
      </div>

      <div className="set-group-title">Built-in Protections</div>
      <div className="set-card">
        {(rules?.builtins ?? []).map(({ rule, disabled }) => (
          <div className={'rule-row' + (disabled ? ' off' : '')} key={rule.id}>
            <span className={'rule-badge ' + (disabled ? 'off' : 'deny')}>
              {disabled ? 'off' : 'deny'}
            </span>
            <span className="rule-action">{rule.action}</span>
            <span className="rule-match">{rule.match}</span>
            {disabled ? (
              <button className="small-btn" onClick={() => runSetBuiltinDisabled(rule, false)}>
                Enable
              </button>
            ) : (
              <button className="small-btn" onClick={() => confirmDisable(rule)}>
                Disable
              </button>
            )}
          </div>
        ))}
        {builtinsError ? <div className="rule-error">{builtinsError}</div> : null}
      </div>
    </>
  )
}
