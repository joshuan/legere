// What the bucket holds, as of the last time anyone counted (docs/09 §9.5).
export type StorageUsage = {
  objects: number;
  bytes: string;
  measuredAt: string;
};

// A single number the admin panel shows and the maintenance job refreshes. In-process on purpose:
// one process serves the whole instance (docs/02 §2.1), and a figure that is an hour old does not
// deserve a table.
export abstract class MetricsCache {
  abstract setStorageUsage(usage: StorageUsage): void;

  abstract getStorageUsage(): StorageUsage | null;
}
