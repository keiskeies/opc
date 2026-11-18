/** 由 probe303-slice-old.mjs 从 `git show HEAD:` 切出来的【旧字节】，别手改。 */
export function isInsideWorkspace(workspace: string, target: string): boolean {
  const root: string = normalizeAbs(workspace);
  const p: string = normalizeAbs(target);
  if (p === root) return true;
  return p.startsWith(root.endsWith("/") ? root : root + "/");
}

function normalizeAbs(p: string): string {
  const parts: string[] = [];
  const abs: boolean = p.startsWith("/");
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!abs) parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  return (abs ? "/" : "") + parts.join("/");
}
