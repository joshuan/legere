import type { OAuthClientAuthMethod } from '../../../shared/contracts/oauth';
import type { TransactionHandle } from '../../application/ports/unit-of-work';

export type OAuthClient = {
  id: string;
  name: string;
  scope: string;
  redirectUris: string[];
  authMethod: OAuthClientAuthMethod;
  secretHash: string | null;
  createdAt: Date;
};
export type OAuthGrant = {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  resource: string;
  scope: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};
export type OAuthCode = {
  hash: string;
  grantId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: Date;
  consumedAt: Date | null;
};
export type OAuthRefreshToken = {
  hash: string;
  grantId: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

export const MAX_OAUTH_CLIENTS = 10_000;

export abstract class OAuthRepository {
  // Null means the instance-wide registration ceiling was reached.
  abstract register(input: Omit<OAuthClient, 'id' | 'createdAt'>): Promise<OAuthClient | null>;
  abstract findClient(id: string): Promise<OAuthClient | null>;
  abstract createGrant(
    input: Omit<OAuthGrant, 'id' | 'createdAt' | 'revokedAt'>,
    tx: TransactionHandle,
  ): Promise<OAuthGrant>;
  // Locks the grant through exchange or revocation, serializing refresh rotation and replay checks.
  abstract lockGrant(id: string, tx: TransactionHandle): Promise<OAuthGrant | null>;
  abstract listGrants(userId: string): Promise<OAuthGrant[]>;
  abstract revokeGrant(id: string, now: Date, tx: TransactionHandle): Promise<void>;
  abstract createCode(input: Omit<OAuthCode, 'consumedAt'>, tx: TransactionHandle): Promise<void>;
  abstract findCode(hash: string, tx: TransactionHandle): Promise<OAuthCode | null>;
  abstract consumeCode(hash: string, now: Date, tx: TransactionHandle): Promise<void>;
  abstract createRefresh(
    input: Omit<OAuthRefreshToken, 'consumedAt'>,
    tx: TransactionHandle,
  ): Promise<void>;
  abstract findRefresh(hash: string, tx: TransactionHandle): Promise<OAuthRefreshToken | null>;
  abstract consumeRefresh(hash: string, now: Date, tx: TransactionHandle): Promise<void>;
}
