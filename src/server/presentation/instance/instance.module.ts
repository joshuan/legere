import { Module } from '@nestjs/common';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { AdminInstanceController } from './admin-instance.controller';

// The operator's view of the instance itself (docs/06 §6.5). One read-only route, so it keeps its
// own small module rather than borrowing the queue's: they answer different questions and are only
// neighbours on the navigation.
@Module({
  controllers: [AdminInstanceController],
  providers: [...sessionGuardProviders],
})
export class InstanceModule {}
