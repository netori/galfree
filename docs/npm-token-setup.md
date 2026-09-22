# 把 npm automation token 存进用户级 .npmrc(凭据不进聊天、不进仓库、不回显)

这个脚本做一件小事:让你在**自己的终端**里粘一次 token,它把凭据写进
`~/.npmrc`(用户级,不在任何仓库里),再顺手核一下身份。
token 本身**不会**打印出来,也不会经过对话。

## 第 1 步:生成 token

1. 打开 <https://www.npmjs.com/settings/~/tokens>(登录你的 npm 账号)
2. **Generate New Token** → 选 **Automation**(不是 Classic / Granular Access)
   - Automation 类型专为 CI/脚本设计,**会绕过两步验证**,所以以后发版不用再输验证码
   - 权限按 npm 的默认即可(发布自己名下的包够用)
3. 生成后**立刻复制**那一串(形如 `npm_xxxxxxxx...`,只显示一次)

## 第 2 步:存进本机(在你自己的 PowerShell 里跑)

```powershell
$t = Read-Host -AsSecureString "粘贴 npm automation token"
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($t))
$rc = Join-Path $env:USERPROFILE '.npmrc'
if (Select-String -Path $rc -Pattern '^//registry\.npmjs\.org/:_authToken=' -Quiet -ErrorAction SilentlyContinue) {
  (Get-Content $rc) -notmatch '^//registry\.npmjs\.org/:_authToken=' | Set-Content $rc -Encoding utf8
}
Add-Content $rc "//registry.npmjs.org/:_authToken=$plain" -Encoding utf8
$plain = $null
# 核对:应打印你的 npm 用户名
npm whoami --registry=https://registry.npmjs.org/
```

- `Read-Host -AsSecureString` 输入时**不回显**;
- 写的是 `~/.npmrc`,**不是仓库里的 `.npmrc`**(仓库那个只钉 registry,没有凭据);
- 最后那条 `whoami` 打印出用户名就说明凭据生效了。

## 第 3 步:回来告诉我"存好了"

我会跑 `npm run release:npm`(它会:检查身份 → 检查工作区干净 → 检查版本未发 →
`npm publish` → **从 registry 读回来核对**),然后把结果给你看。

## 想撤销时

```powershell
# 删掉本机凭据
(Get-Content (Join-Path $env:USERPROFILE '.npmrc')) -notmatch '^//registry\.npmjs\.org/:_authToken=' | Set-Content (Join-Path $env:USERPROFILE '.npmrc') -Encoding utf8
```

或去 <https://www.npmjs.com/settings/~/tokens> 把那个 token 撤销(Revoke)。
