import { Injectable } from '@nestjs/common';
import { MetricsCache, type StorageUsage } from '../../application/ports/metrics-cache';

// The instance is one process (docs/02 §2.1), so the cache is a field. It starts empty, and the
// admin panel says "not measured yet" until the first maintenance run — which is the truth.
@Injectable()
export class InMemoryMetricsCache extends MetricsCache {
  private usage: StorageUsage | null = null;

  setStorageUsage(usage: StorageUsage): void {
    this.usage = usage;
  }

  getStorageUsage(): StorageUsage | null {
    return this.usage;
  }
}
