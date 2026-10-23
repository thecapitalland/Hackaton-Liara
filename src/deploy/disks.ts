/**
 * اتصال دیسک هنگام deploy، مطابق بستهٔ منتشرشدهٔ @liara/cli@9.6.0.
 *
 * بدنهٔ release فیلد disks را با شکل {name, mountTo} می‌فرستد:
 *   package/lib/commands/deploy.js:264          disks: config.disks
 *   package/lib/commands/deploy.js:553-558      { name, mountTo }
 *   package/lib/types/disk.d.ts:1-4             interface فقط name و mountTo
 *
 * ساخت دیسک دستور جداست و size در آن نوع نیست:
 *   package/lib/commands/disk/create.js:20      POST { name, size }
 *   package/lib/commands/disk/create.js:85-91   پیام CLI: اندازه به گیگابایت
 *
 * فهرست دیسک:
 *   package/lib/commands/init.js:260-262        GET v1/projects/{id}/disks و disks.disks
 *   package/lib/types/get-disk-response.d.ts:1-15
 *     disks[].name و disks[].size ؛ mounts[].mountedTo فیلد release نیست و فرستاده نمی‌شود.
 */
import type { DiskMount } from "./detect.js";

export interface ReleaseDisk {
  name: string;
  mountTo: string;
}

export interface RemoteDisk {
  name: string;
  size: string | null;
}

export interface DiskCreateSpec {
  name: string;
  size: string;
  mountTo: string;
}

export interface DiskLine {
  name: string;
  mountTo: string;
  size: string | null;
  action: "create" | "mount" | "blocked";
}

export interface DiskMountPlan {
  releaseDisks: ReleaseDisk[];
  creates: DiskCreateSpec[];
  blocked: ReleaseDisk[];
  lines: DiskLine[];
}

/** همان آرایه‌ای که deploy.js داخل body.release می‌گذارد. size عمداً نیست. */
export function releaseDiskField(disks: readonly { name: string; mountTo: string }[]): ReleaseDisk[] {
  return disks.map((disk) => ({ name: disk.name, mountTo: disk.mountTo }));
}

/** بدنهٔ POST ساخت. create.js:20 فقط name و size دارد؛ mountTo در این POST نیست. */
export function diskCreateBody(disk: { name: string; size: string }): { name: string; size: string } {
  return { name: disk.name, size: disk.size };
}

/**
 * disks.disks طبق init.js:262. اگر این شکل نباشد null است و هیچ ساختی انجام نمی‌شود.
 */
export function parseRemoteDisks(payload: unknown): RemoteDisk[] | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const rows = (payload as { disks?: unknown }).disks;
  if (!Array.isArray(rows)) return null;
  const out: RemoteDisk[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") return null;
    const name = (row as { name?: unknown }).name;
    if (typeof name !== "string" || !name.trim()) return null;
    const size = (row as { size?: unknown }).size;
    let sizeText: string | null = null;
    if (typeof size === "number" && Number.isFinite(size)) sizeText = String(size);
    else if (typeof size === "string" && size.trim()) sizeText = size.trim();
    out.push({ name: name.trim(), size: sizeText });
  }
  return out;
}

export function planDiskMounts(local: readonly DiskMount[], remote: readonly RemoteDisk[]): DiskMountPlan {
  const byName = new Map(remote.map((disk) => [disk.name, disk]));
  const creates: DiskCreateSpec[] = [];
  const blocked: ReleaseDisk[] = [];
  const lines: DiskLine[] = [];
  for (const disk of local) {
    const found = byName.get(disk.name);
    if (found) {
      lines.push({ name: disk.name, mountTo: disk.mountTo, size: found.size, action: "mount" });
      continue;
    }
    if (disk.size) {
      creates.push({ name: disk.name, size: disk.size, mountTo: disk.mountTo });
      lines.push({ name: disk.name, mountTo: disk.mountTo, size: disk.size, action: "create" });
      continue;
    }
    blocked.push({ name: disk.name, mountTo: disk.mountTo });
    lines.push({ name: disk.name, mountTo: disk.mountTo, size: null, action: "blocked" });
  }
  return {
    releaseDisks: releaseDiskField(local),
    creates,
    blocked,
    lines,
  };
}

export function formatDiskCard(plan: DiskMountPlan): string {
  if (!plan.lines.length) return "";
  const rows = plan.lines.map((line) => {
    const size = line.size === null ? "اندازه در دادهٔ موجود نیست" : `اندازه ${line.size}`;
    const action =
      line.action === "create"
        ? "روی اپ نیست؛ بعد از تأیید ساخته می‌شود و mountTo در release می‌رود"
        : line.action === "mount"
          ? "روی اپ هست؛ mountTo در بدنهٔ release فرستاده می‌شود"
          : "ساخته نمی‌شود تا اندازه مشخص شود";
    return `• ${line.name} → ${line.mountTo} — ${size} — ${action}`;
  });
  return ["دیسک‌های liara.json:", ...rows].join("\n");
}

export function missingDiskSizeCard(blocked: readonly ReleaseDisk[]): {
  text: string;
  structured: Record<string, unknown>;
} {
  return {
    text: [
      "این دیسک‌ها روی اپ نیستند و liara.json برایشان size ندارد.",
      ...blocked.map((disk) => `• ${disk.name} → ${disk.mountTo}`),
      "در @liara/cli@9.6.0 نوع دیسک liara.json فقط {name, mountTo} است (package/lib/types/disk.d.ts:1-4).",
      "ساخت دیسک دستور جداست و اندازه را جدا می‌گیرد (package/lib/commands/disk/create.js:20، بدنهٔ {name, size}).",
      "عددی ساخته نشد. کلید size را در همان شیء دیسک بگذارید، یا liara_create_disk را با اندازهٔ مشخص تأیید کنید.",
      "تا آن وقت هیچ POST ساخت دیسک و هیچ release با این mount فرستاده نمی‌شود.",
    ].join("\n"),
    structured: { ok: false, code: "DISK_SIZE_REQUIRED", disks: blocked.map((disk) => ({ ...disk })) },
  };
}

export function mountsAreAuthorized(
  planned: readonly ReleaseDisk[],
  approved: readonly ReleaseDisk[] | undefined,
): boolean {
  if (planned.length !== (approved ?? []).length) return false;
  return planned.every((item) =>
    (approved ?? []).some((card) => card.name === item.name && card.mountTo === item.mountTo),
  );
}

export function createsAreAuthorized(
  planned: readonly DiskCreateSpec[],
  approved: readonly DiskCreateSpec[] | undefined,
): boolean {
  return planned.every((item) =>
    (approved ?? []).some(
      (card) => card.name === item.name && card.size === item.size && card.mountTo === item.mountTo,
    ),
  );
}

/** کارت باید همان size و mountTo ساخت، و mountTo اتصال را از روی فیلدهای ساخت‌یافته نشان بدهد. */
export function cardShowsDiskPlan(
  lines: readonly DiskLine[] | undefined,
  releaseDisks: readonly ReleaseDisk[],
  creates: readonly DiskCreateSpec[],
): boolean {
  const shown = lines ?? [];
  const mountsShown = releaseDisks.every((disk) =>
    shown.some(
      (line) =>
        line.name === disk.name &&
        line.mountTo === disk.mountTo &&
        (line.action === "mount" || line.action === "create"),
    ),
  );
  const createsShown = creates.every((disk) =>
    shown.some(
      (line) =>
        line.action === "create" &&
        line.name === disk.name &&
        line.size === disk.size &&
        line.mountTo === disk.mountTo,
    ),
  );
  return mountsShown && createsShown;
}
