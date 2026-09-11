/** 侧边栏入口图标(收 shell 传入的 size/active props)。 */
export function GalfreeIcon(props: { size?: number; active?: boolean }) {
  const { size = 18 } = props
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x={1.5} y={2.5} width={13} height={11} rx={1.5} />
      <path d="M1.5 5.5h13" />
      <circle cx={3.4} cy={4} r={0.5} fill="currentColor" />
      <path d="M4.5 10.2l2.2-2 1.6 1.4 2.2-2.2 1.5 1.8" />
    </svg>
  )
}
