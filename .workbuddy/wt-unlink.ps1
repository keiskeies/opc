# 拆掉 worktree 里那 5 个 junction（只删链接，绝不顺着删进真 node_modules）。
# 为什么不用 rm -rf / Remove-Item -Recurse：那是【顺着链接走进去删真目录】，
# 真 node_modules 会没。判据先落在代码里：不是 ReparsePoint 就【不动它】。
$ErrorActionPreference = "Stop"
$paths = @(
  "C:\Users\Administrator\AppData\Local\Temp\wt-verify\node_modules",
  "C:\Users\Administrator\AppData\Local\Temp\wt-verify\packages\contracts\node_modules",
  "C:\Users\Administrator\AppData\Local\Temp\wt-verify\packages\desktop\node_modules",
  "C:\Users\Administrator\AppData\Local\Temp\wt-verify\packages\hub\node_modules",
  "C:\Users\Administrator\AppData\Local\Temp\wt-verify\packages\web\node_modules"
)
foreach ($p in $paths) {
  if (-not (Test-Path -LiteralPath $p)) {
    Write-Output ("跳过（本来就不存在）：" + $p)
    continue
  }
  $item = Get-Item -LiteralPath $p -Force
  if ($item.LinkType -ne "Junction" -and $item.LinkType -ne "SymbolicLink") {
    Write-Output ("【不动它】LinkType=" + $item.LinkType + "（不是链接）：" + $p)
    continue
  }
  # Junction 用 Directory.Delete(路径, false)：删链接本身，不进目标。
  [System.IO.Directory]::Delete($p, $false)
  Write-Output ("已删链接（" + $item.LinkType + "）：" + $p)
}
