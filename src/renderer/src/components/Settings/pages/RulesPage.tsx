import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { RuleEntry } from '@shared/types'
import { useAppStore } from '../../../state/store'
import { PluginBadge } from '../../PluginBadge'
import { EmptyState } from '../../ui/EmptyState'
import { Loading } from '../../ui/Loading'

// Read-only by design (Phase G plugins arc, Task 12 fix): rules stay
// file-managed (.agents/rules/*.md, project + global), the same as
// workflows -- there is no editor here, only the live list. This is the
// third provenance surface alongside SkillsPage/ConnectorsPage: a
// plugin-sourced rule renders a <PluginBadge> so a user can see which
// plugin owns it (mirrors entry.plugin on SkillEntry / McpServerConfig).
const ACTIVATION_LABEL: Record<RuleEntry['activation'], string> = {
  always: 'Always',
  manual: 'Manual',
  model: 'Model',
  glob: 'Glob'
}

export function RulesPage(): JSX.Element | null {
  const settings = useAppStore((s) => s.settings)
  const workspacePath = useAppStore((s) => s.workspacePath)

  const [rules, setRules] = useState<RuleEntry[] | null>(null)

  useEffect(() => {
    void window.bearcode.rules.list(workspacePath).then((list) => setRules(list))
  }, [workspacePath])

  if (!settings) return null

  return (
    <>
      <div className="page-title">Rules</div>
      <div className="page-sub">
        Standing instructions the agent always follows or applies by name/glob/description. Edited
        as files under <code>.agents/rules/</code> — this page shows what&apos;s live.
      </div>

      <div className="set-group-title">Active rules</div>
      <div className="set-card">
        {rules === null ? (
          <div className="set-row">
            <Loading />
          </div>
        ) : rules.length === 0 ? (
          <div className="set-row">
            <EmptyState
              title="No rules yet"
              hint={
                <>
                  Add a <code>.md</code> file under <code>.agents/rules/</code> (project) or{' '}
                  <code>~/.bearcode/agents/rules/</code> (global).
                </>
              }
            />
          </div>
        ) : (
          rules.map((entry) => (
            <div
              className="set-row"
              style={entry.error ? { opacity: 0.5 } : undefined}
              key={`${entry.source}:${entry.name}`}
            >
              <div className="set-row-text">
                <div className="set-row-title">
                  {entry.name}
                  <span className={'connector-badge' + (entry.source === 'global' ? '' : ' local')}>
                    {entry.source === 'global' ? 'Global' : 'Project'}
                  </span>
                  <span className="connector-badge">{ACTIVATION_LABEL[entry.activation]}</span>
                  {entry.plugin ? <PluginBadge name={entry.plugin} /> : null}
                </div>
                <div className="set-row-desc">
                  {entry.error ? `Error: ${entry.error}` : entry.description || 'No description.'}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  )
}
