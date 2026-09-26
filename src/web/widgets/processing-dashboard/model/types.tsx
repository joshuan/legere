'use client';

import { useTranslations } from 'next-intl';
import type {
  ProcessingSnapshotResponse,
  ProcessingTopologyDto,
} from '../../../../shared/contracts/processing';

export type QueueRow = ProcessingSnapshotResponse['queues'][number];

export type PipelineRow = ProcessingSnapshotResponse['pipeline']['steps'][number];

export type ServiceRow = ProcessingSnapshotResponse['services'][number];

export type ServiceHealth = NonNullable<ServiceRow['health']['value']>;

export type QueueTopology = ProcessingTopologyDto['queues'][number];

export type StepTopology = ProcessingTopologyDto['pipeline']['steps'][number];

export type ServiceTopology = ProcessingTopologyDto['services'][number];

export type Translate = ReturnType<typeof useTranslations>;
