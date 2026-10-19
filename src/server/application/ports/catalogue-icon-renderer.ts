export abstract class CatalogueIconRenderer {
  abstract render(bytes: Buffer): Promise<Buffer>;
}
