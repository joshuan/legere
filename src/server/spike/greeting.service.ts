import { Injectable } from '@nestjs/common';

// SWC decorator-metadata spike (M0.3): a leaf provider injected by type into SpikeService.
// If SWC did not emit `design:paramtypes`, Nest could not resolve SpikeService's constructor.
@Injectable()
export class GreetingService {
  greet(name: string): string {
    return `Hello, ${name}`;
  }
}
