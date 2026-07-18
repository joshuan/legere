import { Injectable } from '@nestjs/common';
import { GreetingService } from './greeting.service';

// Constructor injection by type — resolves only when decorator metadata is present.
@Injectable()
export class SpikeService {
  constructor(private readonly greeting: GreetingService) {}

  run(): string {
    return this.greeting.greet('Legere');
  }
}
