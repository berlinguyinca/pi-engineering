/**
 * Filesystem type detection (spec §20).
 *
 * SQLite WAL needs shared memory that network/distributed filesystems do not
 * provide reliably, and POSIX advisory locking differs across them. Detecting
 * the filesystem lets the coordination database stay on a machine-local
 * filesystem even when the state directory (e.g. a NFS-mounted home) is not.
 */
import { statfsSync } from "node:fs";

/** statfs(2) f_type magic numbers (linux/magic.h and vendor headers). */
const MAGIC: ReadonlyMap<number, string> = new Map([
  [0xef53, "ext4"],
  [0x9123683e, "btrfs"],
  [0x58465342, "xfs"],
  [0x2fc12fc1, "zfs"],
  [0x01021994, "tmpfs"],
  [0x794c7630, "overlayfs"],
  [0xf2f52010, "f2fs"],
  [0x5346544e, "ntfs"],
  [0x4d44, "vfat"],
  [0x6969, "nfs"],
  [0xff534d42, "cifs"],
  [0xfe534d42, "smb2"],
  [0x517b, "smb"],
  [0x0bd00bd0, "lustre"],
  [0x19830326, "beegfs"],
  [0x47504653, "gpfs"],
  [0x65735546, "fuse"],
  [0x00c36400, "ceph"],
  [0x013111a8, "ibrix"],
  [0x6b414653, "afs"],
  [0x73717368, "squashfs"],
]);

const NETWORK = new Set(["nfs", "cifs", "smb2", "smb", "lustre", "beegfs", "gpfs", "ceph", "ibrix", "afs", "fuse"]);

export interface FilesystemInfo {
  type: string;
  network: boolean;
}

export function filesystemInfo(path: string): FilesystemInfo {
  try {
    const raw = Number(statfsSync(path).type) >>> 0;
    const type = MAGIC.get(raw) ?? `0x${raw.toString(16)}`;
    return { type, network: NETWORK.has(type) };
  } catch {
    return { type: "unknown", network: false };
  }
}

/** Override for tests and unusual setups: treat every path as network-backed. */
export function forcedNetworkFilesystem(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_ENGINEERING_ASSUME_NETWORK_FS === "1";
}
