import { Controller, Delete, Get, Patch, Post, UseGuards } from '@nestjs/common';
import {
  addCollectionItemRequestSchema,
  collectionItemsQuerySchema,
  createCollectionRequestSchema,
  createShareRequestSchema,
  updateCollectionRequestSchema,
  type AddCollectionItemRequest,
  type CollectionDetailResponse,
  type CollectionDto,
  type CollectionItemsQuery,
  type CollectionShareDto,
  type CreateCollectionRequest,
  type CreateShareRequest,
  type ListCollectionSharesResponse,
  type ListCollectionsResponse,
  type UpdateCollectionRequest,
} from '../../../shared/contracts/collections';
import type { Envelope } from '../../../shared/contracts/common';
import {
  userLookupQuerySchema,
  type OkResponse,
  type UserLookupQuery,
  type UserLookupResponse,
} from '../../../shared/contracts/users';
import {
  AddCollectionItem,
  CreateCollection,
  DeleteCollection,
  GetCollection,
  ListCollections,
  ListCollectionShares,
  RemoveCollectionItem,
  RevokeShare,
  ShareCollection,
  UpdateCollection,
} from '../../application/collections/manage-collections';
import { LookupUsers } from '../../application/collections/lookup-users';
import type { User } from '../../domain/entities/user';
import { CurrentUser } from '../auth/current-user';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodBody, ZodQuery } from '../http/zod-validation.pipe';
import { UuidParam } from '../http/uuid-param.pipe';

// Collections and sharing (docs/07 §7.3). Reading is decided by ownership or an active share;
// changing anything is the owner's alone (docs/03 §3.4).
@Controller('collections')
@UseGuards(SessionGuard)
export class CollectionsController {
  constructor(
    private readonly list: ListCollections,
    private readonly create: CreateCollection,
    private readonly get: GetCollection,
    private readonly update: UpdateCollection,
    private readonly remove: DeleteCollection,
    private readonly addItem: AddCollectionItem,
    private readonly removeItem: RemoveCollectionItem,
    private readonly listShares: ListCollectionShares,
    private readonly share: ShareCollection,
    private readonly revoke: RevokeShare,
  ) {}

  @Get()
  async listCollections(@CurrentUser() user: User): Promise<Envelope<ListCollectionsResponse>> {
    return successEnvelope(await this.list.execute(viewerOf(user)));
  }

  @Post()
  async createCollection(
    @CurrentUser() user: User,
    @ZodBody(createCollectionRequestSchema) body: CreateCollectionRequest,
  ): Promise<Envelope<CollectionDto>> {
    return successEnvelope(await this.create.execute(viewerOf(user), body));
  }

  @Get(':id')
  async getCollection(
    @CurrentUser() user: User,
    @UuidParam('id', 'COLLECTION_NOT_FOUND', 'Collection') id: string,
    @ZodQuery(collectionItemsQuerySchema) query: CollectionItemsQuery,
  ): Promise<Envelope<CollectionDetailResponse>> {
    return successEnvelope(await this.get.execute(viewerOf(user), id, query));
  }

  @Patch(':id')
  async updateCollection(
    @CurrentUser() user: User,
    @UuidParam('id', 'COLLECTION_NOT_FOUND', 'Collection') id: string,
    @ZodBody(updateCollectionRequestSchema) body: UpdateCollectionRequest,
  ): Promise<Envelope<CollectionDto>> {
    return successEnvelope(await this.update.execute(viewerOf(user), id, body));
  }

  @Delete(':id')
  async deleteCollection(
    @CurrentUser() user: User,
    @UuidParam('id', 'COLLECTION_NOT_FOUND', 'Collection') id: string,
  ): Promise<Envelope<OkResponse>> {
    return successEnvelope(await this.remove.execute(viewerOf(user), id));
  }

  @Post(':id/items')
  async addCollectionItem(
    @CurrentUser() user: User,
    @UuidParam('id', 'COLLECTION_NOT_FOUND', 'Collection') id: string,
    @ZodBody(addCollectionItemRequestSchema) body: AddCollectionItemRequest,
  ): Promise<Envelope<OkResponse>> {
    return successEnvelope(await this.addItem.execute(viewerOf(user), id, body));
  }

  @Delete(':id/items/:documentId')
  async removeCollectionItem(
    @CurrentUser() user: User,
    @UuidParam('id', 'COLLECTION_NOT_FOUND', 'Collection') id: string,
    @UuidParam('documentId', 'DOCUMENT_NOT_FOUND', 'Document') documentId: string,
  ): Promise<Envelope<OkResponse>> {
    return successEnvelope(await this.removeItem.execute(viewerOf(user), id, documentId));
  }

  @Get(':id/shares')
  async getShares(
    @CurrentUser() user: User,
    @UuidParam('id', 'COLLECTION_NOT_FOUND', 'Collection') id: string,
  ): Promise<Envelope<ListCollectionSharesResponse>> {
    return successEnvelope(await this.listShares.execute(viewerOf(user), id));
  }

  @Post(':id/shares')
  async createShare(
    @CurrentUser() user: User,
    @UuidParam('id', 'COLLECTION_NOT_FOUND', 'Collection') id: string,
    @ZodBody(createShareRequestSchema) body: CreateShareRequest,
  ): Promise<Envelope<CollectionShareDto>> {
    return successEnvelope(await this.share.execute(viewerOf(user), id, body));
  }

  @Delete(':id/shares/:shareId')
  async revokeShare(
    @CurrentUser() user: User,
    @UuidParam('id', 'COLLECTION_NOT_FOUND', 'Collection') id: string,
    @UuidParam('shareId', 'NOT_FOUND', 'Share') shareId: string,
  ): Promise<Envelope<OkResponse>> {
    return successEnvelope(await this.revoke.execute(viewerOf(user), id, shareId));
  }
}

// GET /api/users/lookup (docs/07 §7.3): the share picker's directory, and nothing more than it
// needs — capped at ten, active users only.
@Controller('users')
@UseGuards(SessionGuard)
export class UserLookupController {
  constructor(private readonly lookup: LookupUsers) {}

  @Get('lookup')
  async lookupUsers(
    @ZodQuery(userLookupQuerySchema) query: UserLookupQuery,
  ): Promise<Envelope<UserLookupResponse>> {
    return successEnvelope(await this.lookup.execute(query));
  }
}

function viewerOf(user: User): { id: string; role: User['role'] } {
  return { id: user.id, role: user.role };
}
