import { Module } from '@nestjs/common';
import { GreetingService } from './greeting.service';
import { SpikeService } from './spike.service';

@Module({
  providers: [GreetingService, SpikeService],
  exports: [SpikeService],
})
export class SpikeModule {}
