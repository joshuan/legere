import type { TransactionHandle } from '../../application/ports/unit-of-work';

export type Integration = {
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
  revokedAt: Date | null;
};

export abstract class IntegrationRepository {
  abstract create(userId: string, name: string, tx?: TransactionHandle): Promise<Integration>;
  abstract findOwned(
    id: string,
    userId: string,
    tx?: TransactionHandle,
  ): Promise<Integration | null>;
  abstract list(userId: string): Promise<Array<Integration & { documentCount: number }>>;
  abstract revoke(id: string, now: Date, tx?: TransactionHandle): Promise<void>;
}
