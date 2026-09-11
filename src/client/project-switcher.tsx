/**
 * 项目切换器。
 *
 * spec 原本把"多项目切换 UI"划在 v1 之外(User Story 29「切换 UI 后补」、#9「切换 UI 不做」、
 * 接缝契约「无 activate 路由」)。这里实现它,是发起人在本轮明确批准的**范围变更**;
 * 相应地把接缝契约的那一行改成了"activate 路由存在,只动注册表激活位"。
 *
 * 它只做一件事:把注册表的激活位挪到另一个项目(经 POST /projects/activate)。
 * 项目内容一律走网关,这里不写任何项目文件。
 */
import { useEffect, useRef, useState } from 'react'
import type { ProjectView } from './api.ts'
import { Chip, Spinner } from './ui.tsx'
import s from './panel.module.css'

export function ProjectSwitcher({ projects, activeId, switching, onActivate }: {
  projects: ProjectView[]
  activeId: string | null
  switching: boolean
  onActivate: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  // 点外面 / 按 Esc 收起(菜单不该粘住)。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (projects.length === 0) return null

  return (
    <div className={s.switcher} ref={root}>
      <button
        type="button"
        className={s.button}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={switching}
        onClick={() => setOpen((value) => !value)}
        title="在已注册的项目之间切换激活位"
      >
        {switching ? <Spinner /> : null}
        项目 <span className={s.cardCount}>{projects.length}</span>
      </button>
      {open ? (
        <div className={s.menu} role="menu">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              role="menuitemradio"
              aria-checked={project.active}
              className={[s.menuItem, project.active ? s.menuItemActive : undefined].filter(Boolean).join(' ')}
              onClick={() => {
                setOpen(false)
                if (!project.active) onActivate(project.id)
              }}
            >
              <span className={s.menuItemMain}>
                <span className={s.menuItemTitle}>
                  {project.title}
                  {project.missing ? <Chip tone="bad">目录缺失</Chip> : null}
                </span>
                <span className={s.menuItemPath}>{project.root}</span>
              </span>
              {project.active ? <span aria-hidden="true">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
