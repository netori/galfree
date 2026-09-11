/** CSS Modules 的类型形状(构建期由 tsdown 的 lightningcss 插件编译)。 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
