#!/usr/bin/env pwsh
# 把本地仓库当前的 HEAD 同步到 GitHub（走 REST Git Data API）。
#
# 为什么需要它：本机 git 走 HTTPS 到 github.com 不可用
#   - ~/.gitconfig 把 github.com 重写成 gh.ddlc.top 镜像（返回 429）
#   - 直连 github.com 时 schannel 报 CRYPT_E_NO_REVOCATION_CHECK，OpenSSL 报 unable to get local issuer certificate
# 而 PowerShell 的 Invoke-RestMethod -SkipCertificateCheck 能正常访问 api.github.com，所以这里用 API 发布。
#
# 用法：
#   pwsh -File tools/publish-github.ps1                      # 同步 HEAD，自动生成提交信息
#   pwsh -File tools/publish-github.ps1 -Message "修 xxx"     # 自定义提交信息
#   pwsh -File tools/publish-github.ps1 -WhatIf               # 只报告差异，不改远端
#
# 凭据来源（按顺序）：
#   1) -Token 参数   2) $env:GITHUB_TOKEN / $env:GH_TOKEN
#   3) Windows 凭据管理器里 "GitHub - https://api.github.com/<owner>"（GitHub Desktop 登录后会有）
# token 不会被打印。
[CmdletBinding()]
param(
  [string]$Owner = 'lsnnn123',
  [string]$Repo = 'dsh-screenshot-win',
  [string]$Dir = (Split-Path -Parent $PSScriptRoot),
  [string]$Token,
  [string]$Message,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
$api = "https://api.github.com/repos/$Owner/$Repo"
$Email = "30714282+$Owner@users.noreply.github.com"

function Get-StoredGitHubToken([string]$owner) {
  if (-not $IsWindows) { return $null }
  $csharp = @'
using System;
using System.Runtime.InteropServices;
public static class DshShotCredMan {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  public static byte[] Read(string target) {
    IntPtr p;
    if (!CredReadW(target, 1, 0, out p)) return null;
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      var b = new byte[c.CredentialBlobSize];
      if (b.Length > 0) Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return b;
    } finally { CredFree(p); }
  }
}
'@
  if (-not ('DshShotCredMan' -as [type])) { Add-Type -TypeDefinition $csharp -Language CSharp | Out-Null }
  foreach ($target in @("GitHub - https://api.github.com/$owner", 'git:https://github.com')) {
    $blob = [DshShotCredMan]::Read($target)
    if (-not $blob) { continue }
    foreach ($decoded in @([System.Text.Encoding]::Unicode.GetString($blob), [System.Text.Encoding]::UTF8.GetString($blob))) {
      $m = [regex]::Match($decoded, '(gh[a-z]?_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})')
      if ($m.Success) { return $m.Value }
    }
  }
  return $null
}

function Get-BlobBytes([string]$sha) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'git'
  $psi.Arguments = "-C `"$Dir`" cat-file blob $sha"
  $psi.RedirectStandardOutput = $true
  $psi.UseShellExecute = $false
  $proc = [System.Diagnostics.Process]::Start($psi)
  $ms = New-Object System.IO.MemoryStream
  $proc.StandardOutput.BaseStream.CopyTo($ms)
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) { throw "git cat-file blob $sha 失败" }
  return $ms.ToArray()
}

if (-not $Token) { $Token = $env:GITHUB_TOKEN; if (-not $Token) { $Token = $env:GH_TOKEN } }
if (-not $Token) { $Token = Get-StoredGitHubToken $Owner }
if (-not $Token) { throw "找不到 GitHub 凭据；请用 -Token 或设置 `$env:GITHUB_TOKEN" }
$H = @{
  Authorization          = "Bearer $Token"
  Accept                 = 'application/vnd.github+json'
  'User-Agent'           = 'dsh-screenshot-win-publish'
  'X-GitHub-Api-Version' = '2022-11-28'
}
function Invoke-GH([string]$method, [string]$uri, $body) {
  $p = @{ Method = $method; Uri = $uri; Headers = $H; TimeoutSec = 90; ContentType = 'application/json' }
  if ($null -ne $body) { $p.Body = ($body | ConvertTo-Json -Depth 10 -Compress) }
  return Invoke-RestMethod @p
}

$dirty = @(& git -C $Dir status --porcelain)
$headSha = (& git -C $Dir rev-parse HEAD).Trim()
"本地 HEAD : $headSha"
if ($dirty.Count -gt 0) { "⚠ 工作区有未提交的改动，本次只发布已提交的 HEAD："; $dirty | ForEach-Object { "    $_" } }

$entries = @()
foreach ($line in @(& git -C $Dir ls-tree -r HEAD)) {
  if ($line -notmatch '^(\d+) blob ([0-9a-f]{40})\t(.+)$') { continue }
  $entries += @{ mode = $Matches[1]; sha = $Matches[2]; path = $Matches[3] }
}
$localTree = (& git -C $Dir rev-parse 'HEAD^{tree}').Trim()
"本地 tree : $localTree  ($($entries.Count) 个文件)"

$info = Invoke-GH 'Get' $api $null
$remote = Invoke-GH 'Get' "$api/commits/$($info.default_branch)" $null
$remoteTree = $remote.commit.tree.sha
"远端 tree : $remoteTree  (HEAD $($remote.sha.Substring(0,7)))"

if ($remoteTree -eq $localTree) { "已经是最新，无需同步。"; exit 0 }

# 远端已有的 blob 不用重传：拿远端 tree 的 path -> sha 做差集（文件内容相同则 sha 相同）
$remoteBlobs = @{}
if ($remoteTree) {
  $rt = Invoke-GH 'Get' "$api/git/trees/$remoteTree`?recursive=1" $null
  foreach ($t in $rt.tree) { if ($t.type -eq 'blob') { $remoteBlobs[$t.path] = $t.sha } }
}
$toUpload = @($entries | Where-Object { $remoteBlobs[$_.path] -ne $_.sha })
"需要上传/更新的文件：$($toUpload.Count) 个"
foreach ($e in $toUpload) { "    $($e.path)" }
if ($WhatIf) { "(-WhatIf：未改动远端)"; exit 0 }

foreach ($e in $toUpload) {
  $raw = Get-BlobBytes $e.sha
  $r = Invoke-GH 'Post' "$api/git/blobs" @{ content = [Convert]::ToBase64String($raw); encoding = 'base64' }
  if ($r.sha -ne $e.sha) { throw "blob 校验失败 $($e.path)：本地 $($e.sha) 远端 $($r.sha)" }
}

$treePayload = @()
foreach ($e in $entries) { $treePayload += @{ path = $e.path; mode = $e.mode; type = 'blob'; sha = $e.sha } }
$tree = Invoke-GH 'Post' "$api/git/trees" @{ tree = $treePayload }
if ($tree.sha -ne $localTree) { throw "tree 校验失败：本地 $localTree 远端 $($tree.sha)" }
"远端 tree : $($tree.sha)  == 本地 tree"

if (-not $Message) {
  $Message = (& git -C $Dir log -1 --format=%s).Trim()
}
$stamp = [DateTimeOffset]::Now.ToString('yyyy-MM-ddTHH:mm:sszzz')
$sig = @{ name = $Owner; email = $Email; date = $stamp }
$commit = Invoke-GH 'Post' "$api/git/commits" @{ message = $Message; tree = $tree.sha; parents = @($remote.sha); author = $sig; committer = $sig }
$ref = Invoke-GH 'Patch' "$api/git/refs/heads/$($info.default_branch)" @{ sha = $commit.sha; force = $true }
"已提交  : $($commit.sha)"
"$($ref.ref) -> $($ref.object.sha)"
"仓库     : $($info.html_url)"
