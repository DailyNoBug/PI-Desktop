// electron/main/storage/files.ts
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, isAbsolute, join as join2, relative, resolve, sep } from "node:path";

// electron/main/storage/preferences.ts
var STORAGE_PREFERENCE_FILE = "storage-location.json";

// electron/main/storage/link-types.ts
import { execFile } from "node:child_process";
import { join } from "node:path";
async function storageLinkTypes(paths) {
  if (process.platform !== "win32") return paths.map(() => void 0);
  if (!paths.length) return [];
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Windows system directory is unavailable.");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)",
    "$paths = ConvertFrom-Json ([Console]::In.ReadToEnd())",
    "$types = @(foreach ($path in $paths) { $type = 'file'; try { $item = Get-Item -LiteralPath $path -Force; if ($item.LinkType -eq 'Junction') { $type = 'junction' } elseif ($item.LinkType -eq 'SymbolicLink') { $target = [string]$item.Target; if ($target -and -not [IO.Path]::IsPathRooted($target)) { $target = Join-Path $item.DirectoryName $target }; if ($target -and (Test-Path -LiteralPath $target -ErrorAction SilentlyContinue)) { if (([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::Directory) -ne 0) { $type = 'dir' } else { $type = 'file' } } elseif (($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0) { $type = 'dir' } else { $type = 'file' } } else { if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) -ne 0) { $type = 'junction' } else { $type = 'file' } } } catch { $type = if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) -ne 0) { 'dir' } else { 'file' } }; $type })",
    "ConvertTo-Json -InputObject $types -Compress"
  ].join("; ");
  const output = await new Promise((resolve2, reject) => {
    const child = execFile(
      join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve2(stdout)
    );
    child.stdin?.on("error", reject);
    child.stdin?.end(JSON.stringify(paths));
  });
  const types = JSON.parse(output);
  if (!Array.isArray(types) || types.length !== paths.length || !types.every((type) => type === "junction" || type === "dir" || type === "file")) {
    throw new Error("Could not determine Windows storage link types.");
  }
  return types;
}

// electron/main/storage/files.ts
var { chmod, lstat, mkdir, open, readdir, readlink, realpath, rm, statfs, symlink, writeFile, readFile } = fs;
var OWNER_FILE = ".pi-storage-owner.json";
var DATA_CACHE_PATHS = ["cache", "plugins/cache/download", "plugins/cache/backup", "openable-attachments"];
var BROWSER_CACHE_PATHS = ["Cache", "Code Cache", "GPUCache", "DawnCache", "ShaderCache", "GrShaderCache", "GraphiteDawnCache"];
var excluded = (name) => name === STORAGE_PREFERENCE_FILE || name.startsWith("Singleton") || name === "lockfile" || /^\.storage-.*\.tmp$/.test(name);
function contains(parent, child) {
  const part = relative(parent, child);
  return !part || !part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part);
}
async function optionalStat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}
async function validateTarget(path, source, anchor, retryId) {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Select an absolute directory.");
  const target = await canonicalPath(path);
  const existing = await optionalStat(path);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("Select a real directory, not a symbolic link.");
  for (const sourcePath of [source.data, source.browser, anchor]) {
    const canonical = await canonicalPath(sourcePath);
    if (contains(canonical, target) || contains(target, canonical)) throw new Error("The destination must be separate from the current storage directories.");
  }
  if (!existing) await mkdir(path, { recursive: true, mode: 448 });
  const names = await readdir(target);
  if (names.length) {
    if (!retryId) throw new Error("Select an empty destination directory.");
    await assertClaimed(target, retryId, names);
  }
  return target;
}
async function inventory(from, to, entries, browser = false) {
  const info = await lstat(from);
  if (info.isSymbolicLink()) {
    entries.push({ from, to, kind: "link", bytes: 0, mode: info.mode, link: await readlink(from) });
  } else if (info.isDirectory()) {
    entries.push({ from, to, kind: "directory", bytes: 0, mode: info.mode });
    for (const name of await readdir(from)) {
      if (browser && excluded(name)) continue;
      await inventory(join2(from, name), join2(to, name), entries);
    }
  } else if (info.isFile()) {
    entries.push({ from, to, kind: "file", bytes: info.size, mode: info.mode });
  } else {
    throw new Error("Storage contains a special file that cannot be safely migrated.");
  }
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function canonicalPath(path) {
  if (await optionalStat(path)) return realpath(path);
  const parent = dirname(path);
  if (parent === path) return realpath(path);
  return join2(await canonicalPath(parent), relative(parent, path));
}
async function assertClaimed(target, id, names) {
  const owner = join2(target, OWNER_FILE);
  if (!(await lstat(owner)).isFile() || (await lstat(owner)).isSymbolicLink()) throw new Error("Invalid migration ownership marker.");
  const marker = JSON.parse(await readFile(owner, "utf8"));
  if (!marker || typeof marker !== "object" || !("id" in marker) || marker.id !== id || names.some((name) => ![OWNER_FILE, "data", "browser"].includes(name))) throw new Error("Destination contains unrelated data; select an empty directory.");
}
function relocatedLink(entry, mappings) {
  const link = entry.link ?? "";
  const absolute = resolve(dirname(entry.from), link);
  for (const [from, to] of mappings) if (contains(from, absolute)) {
    const next = join2(to, relative(from, absolute));
    return isAbsolute(link) ? next : relative(dirname(entry.to), next);
  }
  return isAbsolute(link) ? process.platform === "win32" ? absolute : link : relative(dirname(entry.to), absolute);
}
async function migrateFiles(input) {
  const { source, anchor, id, progress, relocate } = input;
  const requestedTarget = resolve(input.target);
  const target = await realpath(requestedTarget);
  if (target !== requestedTarget) throw new Error("Destination directory changed identity.");
  const owner = join2(target, OWNER_FILE);
  const names = await readdir(target);
  if (names.length) {
    await assertClaimed(target, id, names);
    await assertSeparate(target, source, anchor);
    await rm(join2(target, "data"), { recursive: true, force: true });
    await rm(join2(target, "browser"), { recursive: true, force: true });
  } else {
    await validateTarget(target, source, anchor);
    await writeFile(owner, JSON.stringify({ id }), { flag: "wx", mode: 384 });
  }
  const next = { data: join2(target, "data"), browser: join2(target, "browser") };
  const entries = [];
  const state = { stage: "scanning", completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 };
  progress({ ...state });
  if (await optionalStat(source.data)) await inventory(await realpath(source.data), next.data, entries);
  else entries.push({ from: source.data, to: next.data, kind: "directory", bytes: 0, mode: 448 });
  await inventory(await realpath(source.browser), next.browser, entries, true);
  state.totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  state.totalFiles = entries.filter((entry) => entry.kind !== "directory").length;
  const links = entries.filter((entry) => entry.kind === "link");
  const types = await storageLinkTypes(links.map((entry) => entry.from));
  const linkTypes = new Map(links.map((entry, index) => [entry.from, types[index]]));
  const space = await statfs(target);
  if (space.bavail * space.bsize < state.totalBytes + 16 * 1024 * 1024) throw new Error("Not enough free space in the destination directory.");
  const mappings = [
    [source.data, next.data],
    [source.browser, next.browser],
    [await canonicalPath(source.data), next.data],
    [await canonicalPath(source.browser), next.browser]
  ];
  const hashes = /* @__PURE__ */ new Map();
  state.stage = "copying";
  for (const entry of entries) {
    try {
      if (entry.kind === "directory") await mkdir(entry.to, { recursive: false, mode: 448 });
      else if (entry.kind === "link") {
        await symlink(relocatedLink(entry, mappings), entry.to, linkTypes.get(entry.from));
        state.completedFiles++;
      } else {
        const hash = createHash("sha256");
        await pipeline(createReadStream(entry.from), new Transform({
          transform(chunk, _encoding, callback) {
            hash.update(chunk);
            state.completedBytes += chunk.length;
            progress({ ...state });
            callback(null, chunk);
          }
        }), createWriteStream(entry.to, { flags: "wx", mode: 384 }));
        hashes.set(entry.from, hash.digest("hex"));
        const file = await open(entry.to, "r+");
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        await chmod(entry.to, entry.mode & 511);
        state.completedFiles++;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Storage copy failed: ${entry.from} -> ${entry.to}
${detail}`, { cause: error });
    }
    progress({ ...state });
  }
  state.stage = "verifying";
  state.completedBytes = 0;
  state.completedFiles = 0;
  progress({ ...state });
  for (const entry of entries) {
    if (entry.kind === "file") {
      const hash = hashes.get(entry.from);
      if (await digest(entry.to) !== hash || await digest(entry.from) !== hash) throw new Error("A storage file changed or failed verification; the original directory is still active.");
      state.completedBytes += entry.bytes;
      state.completedFiles++;
    } else if (entry.kind === "link") {
      if (await readlink(entry.to) !== relocatedLink(entry, mappings)) throw new Error("A symbolic link failed verification.");
      state.completedFiles++;
    }
    progress({ ...state });
  }
  state.stage = "relocating";
  progress({ ...state });
  if (await optionalStat(source.data)) await relocate(source.data, next.data);
  for (const entry of entries.reverse()) if (entry.kind === "directory") await chmod(entry.to, entry.mode & 511);
  state.stage = "complete";
  progress({ ...state });
  return next;
}
async function assertSeparate(target, source, anchor) {
  const canonical = await realpath(target);
  if (canonical !== resolve(target)) throw new Error("Destination directory changed identity.");
  for (const path of [source.data, source.browser, anchor]) {
    const root = await canonicalPath(path);
    if (contains(root, canonical) || contains(canonical, root)) throw new Error("Unsafe overlapping storage directories.");
  }
}
async function safeCachePaths(roots) {
  const candidates = DATA_CACHE_PATHS.map((path) => join2(roots.data, path));
  candidates.push(...BROWSER_CACHE_PATHS.map((path) => join2(roots.browser, path)));
  const partitions = join2(roots.browser, "Partitions");
  if ((await optionalStat(partitions))?.isDirectory() && !(await lstat(partitions)).isSymbolicLink()) {
    for (const entry of await readdir(partitions, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(...BROWSER_CACHE_PATHS.map((path) => join2(partitions, entry.name, path)));
    }
  }
  const result = [];
  for (const candidate of candidates) {
    const root = contains(roots.data, candidate) ? roots.data : roots.browser;
    if (!await optionalStat(candidate)) continue;
    const canonicalRoot = await realpath(root);
    const parent = await realpath(dirname(candidate));
    const info = await lstat(candidate);
    const expectedParent = join2(canonicalRoot, relative(root, dirname(candidate)));
    if (parent !== expectedParent || !contains(canonicalRoot, parent) || info.isSymbolicLink()) continue;
    result.push(candidate);
  }
  return result;
}
async function cacheSize(roots) {
  let bytes = 0;
  for (const path of await safeCachePaths(roots)) {
    const entries = [];
    await inventory(path, path, entries);
    bytes += entries.reduce((sum, entry) => sum + entry.bytes, 0);
  }
  return bytes;
}
async function clearCaches(roots) {
  for (const path of await safeCachePaths(roots)) await rm(path, { recursive: true, force: true });
}
async function removeBackups(backups, active, anchor) {
  const canonicalActive = [await canonicalPath(active.data), await canonicalPath(active.browser)];
  const canonicalAnchor = await realpath(anchor);
  const targets = [];
  for (const backup of backups) for (const path of [backup.data, backup.browser]) {
    if (!await optionalStat(path)) continue;
    const canonical = await realpath(path);
    if (canonicalActive.some((root) => contains(canonical, root) || contains(root, canonical))) throw new Error("Backup overlaps active storage.");
    if (canonical !== canonicalAnchor && contains(canonical, canonicalAnchor)) throw new Error("Backup overlaps installation preferences.");
    targets.push({ path, anchor: canonical === canonicalAnchor });
  }
  for (const target of targets) {
    if (target.anchor) {
      for (const name of await readdir(target.path)) if (!excluded(name)) await rm(join2(target.path, name), { recursive: true, force: true });
    } else await rm(target.path, { recursive: true, force: true });
  }
}
export {
  DATA_CACHE_PATHS,
  cacheSize,
  clearCaches,
  contains,
  migrateFiles,
  removeBackups,
  validateTarget
};
